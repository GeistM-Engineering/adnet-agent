/**
 * Adnet Agent Client
 *
 * Browser-side agent that:
 * - Identifies ad placeholders and renders ads
 * - Collects impression/click events
 * - Batches events in a hash chain
 * - Uploads batches to IPFS
 * - Submits batch CID to smart contract
 */

(async function() {
  'use strict';

  // Configuration
  const CONFIG = {
    threshold: 5,                    // Events before auto-flush
    ipfsUrl: 'https://rootz.digital/api/v0',
    ipfsGateway: 'https://rootz.digital',
    storageKey: 'adnet-agent-state',
    ethersUrl: 'https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js'
  };

  // Contract ABI for submitBatch function
  const CAMPAIGN_WALLET_ABI = [
    'function submitBatch(string ipfsCID, uint256 impressions, uint256 clicks, uint256 reach, bytes32 lastHash)',
    'event BatchSubmitted(address indexed publisher, string ipfsCID, uint256 impressions, uint256 clicks, uint256 reach, bytes32 lastHash, uint256 timestamp)'
  ];

  // Determine the base URL of this script
  const scriptUrl = new URL(document.currentScript.src);
  const EPISTERY_BASE = `${scriptUrl.protocol}//${scriptUrl.host}`;
  const AGENT_BASE = `${EPISTERY_BASE}/agent/geistm/adnet-agent`;

  // Load ethers.js if not already available
  async function loadEthers() {
    if (window.ethers) return window.ethers;

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CONFIG.ethersUrl;
      script.onload = () => resolve(window.ethers);
      script.onerror = () => reject(new Error('Failed to load ethers.js'));
      document.head.appendChild(script);
    });
  }

  let Witness;
  try {
    const module = await import(`${EPISTERY_BASE}/lib/witness.js`);
    Witness = module.default;
  } catch (error) {
    console.warn('[Adnet] Failed to load Epistery Witness:', error);
  }

  class AdnetClient {
    constructor() {
      this.campaigns = [];
      this.renderedAds = new Map();
      this.witness = null;
      this.userAddress = null;
      this.ethers = null;
      this.signer = null;

      // Chain state (loaded from localStorage)
      this.eventChain = [];
      this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';
      this.uniqueUsers = new Set();
      this.flushHistory = [];

      this.init();
    }

    async init() {
      console.log('[Adnet] Initializing browser agent');

      // Load persisted state from localStorage
      this.loadState();

      // Load ethers.js
      try {
        this.ethers = await loadEthers();
        console.log('[Adnet] ethers.js loaded');
      } catch (error) {
        console.warn('[Adnet] Failed to load ethers.js:', error);
      }

      // Connect to Epistery Witness (ensures wallet exists)
      await this.connectEpistery();

      // Fetch available campaigns
      await this.fetchCampaigns();

      // Find and populate ad placeholders
      this.populateAdSlots();

      // Setup flush on page unload
      this.setupUnloadHandler();

      console.log('[Adnet] Agent ready. Chain:', this.eventChain.length, '/', CONFIG.threshold);
    }

    /**
     * Load state from localStorage
     */
    loadState() {
      try {
        const data = localStorage.getItem(CONFIG.storageKey);
        if (data) {
          const state = JSON.parse(data);
          this.eventChain = state.eventChain || [];
          this.lastHash = state.lastHash || this.lastHash;
          this.uniqueUsers = new Set(state.uniqueUsers || []);
          this.flushHistory = state.flushHistory || [];
          console.log('[Adnet] Loaded state:', this.eventChain.length, 'pending events');
        }
      } catch (error) {
        console.warn('[Adnet] Failed to load state:', error);
      }
    }

    /**
     * Save state to localStorage
     */
    saveState() {
      try {
        const state = {
          eventChain: this.eventChain,
          lastHash: this.lastHash,
          uniqueUsers: Array.from(this.uniqueUsers),
          flushHistory: this.flushHistory,
          updated: Date.now()
        };
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
      } catch (error) {
        console.warn('[Adnet] Failed to save state:', error);
      }
    }

    /**
     * Connect to Epistery Witness for wallet access
     */
    async connectEpistery() {
      if (!Witness) {
        console.warn('[Adnet] Epistery Witness not available');
        return;
      }

      try {
        this.witness = await Witness.connect({ rootPath: EPISTERY_BASE });
        const status = this.witness.getStatus();

        if (status.client && status.client.address) {
          this.userAddress = status.client.address;
          console.log('[Adnet] Wallet connected:', this.userAddress);

          // Get signer for contract transactions
          if (this.ethers && this.witness.getSigner) {
            try {
              this.signer = await this.witness.getSigner();
              console.log('[Adnet] Signer ready for contract transactions');
            } catch (e) {
              console.warn('[Adnet] Could not get signer:', e.message);
            }
          }
        } else {
          console.log('[Adnet] No wallet found, Witness will auto-create');
        }
      } catch (error) {
        console.warn('[Adnet] Failed to connect to Epistery:', error);
      }
    }

    /**
     * SHA-256 hash function (browser-native)
     */
    async sha256(data) {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Create hash of event data for chain
     */
    async hashEvent(event, previousHash) {
      const data = JSON.stringify({
        ...event,
        previousHash
      });
      return await this.sha256(data);
    }

    /**
     * Add event to the hash chain
     */
    async addEventToChain(event) {
      const hash = await this.hashEvent(event, this.lastHash);

      const chainedEvent = {
        ...event,
        hash,
        previousHash: this.lastHash,
        chainIndex: this.eventChain.length
      };

      this.eventChain.push(chainedEvent);
      this.lastHash = hash;

      // Track unique users for reach
      if (event.userAddress) {
        this.uniqueUsers.add(event.userAddress);
      }

      // Persist to localStorage
      this.saveState();

      console.log(`[Adnet] Event added. Chain: ${this.eventChain.length}/${CONFIG.threshold}, Reach: ${this.uniqueUsers.size}`);

      // Check if threshold reached
      if (this.eventChain.length >= CONFIG.threshold) {
        await this.flushEvents();
      }

      return chainedEvent;
    }

    /**
     * Record an event (impression or click)
     */
    async recordEvent(campaignId, promotionId, type) {
      const event = {
        campaignId,
        promotionId,
        type,
        userAddress: this.userAddress,
        domain: window.location.hostname,
        timestamp: new Date().toISOString()
      };

      try {
        const chainedEvent = await this.addEventToChain(event);
        console.log(`[Adnet] ${type} recorded:`, chainedEvent.hash.substring(0, 8));
        return chainedEvent;
      } catch (error) {
        console.error(`[Adnet] Failed to record ${type}:`, error);
        return null;
      }
    }

    /**
     * Upload data to IPFS
     */
    async uploadToIPFS(data) {
      try {
        const formData = new FormData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        formData.append('file', blob, 'events.json');

        const response = await fetch(`${CONFIG.ipfsUrl}/add`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          throw new Error(`IPFS upload failed: ${response.status}`);
        }

        const result = await response.json();
        return {
          hash: result.Hash,
          url: `${CONFIG.ipfsGateway}/ipfs/${result.Hash}`
        };
      } catch (error) {
        console.error('[Adnet] IPFS upload error:', error);
        return null;
      }
    }

    /**
     * Submit batch to smart contract
     */
    async submitToContract(ipfsCID, campaignId, impressions, clicks, reach) {
      // Get contract address from cached campaign data
      const campaign = this.campaigns.find(c => c.id === campaignId);
      const contractAddress = campaign?.contractAddress;

      if (!contractAddress) {
        console.warn('[Adnet] No contract address for campaign:', campaignId);
        return null;
      }

      if (!this.ethers || !this.signer) {
        console.warn('[Adnet] ethers or signer not available for contract submission');
        return null;
      }

      try {
        // Convert lastHash to bytes32 format
        const lastHashBytes32 = '0x' + this.lastHash;

        console.log('[Adnet] Submitting batch to contract:', {
          contractAddress,
          ipfsCID,
          impressions,
          clicks,
          reach,
          lastHash: lastHashBytes32
        });

        // Create contract instance
        const contract = new this.ethers.Contract(
          contractAddress,
          CAMPAIGN_WALLET_ABI,
          this.signer
        );

        // Call submitBatch
        const tx = await contract.submitBatch(
          ipfsCID,
          impressions,
          clicks,
          reach,
          lastHashBytes32
        );

        console.log('[Adnet] Transaction submitted:', tx.hash);

        // Wait for confirmation
        const receipt = await tx.wait();
        console.log('[Adnet] Transaction confirmed:', receipt.hash);

        return {
          success: true,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber
        };
      } catch (error) {
        console.error('[Adnet] Contract submission error:', error);
        return { success: false, error: error.message };
      }
    }

    /**
     * Flush events - upload to IPFS and submit to contract
     */
    async flushEvents() {
      if (this.eventChain.length === 0) {
        console.log('[Adnet] No events to flush');
        return [];
      }

      console.log(`[Adnet] Flushing ${this.eventChain.length} events`);

      // Group events by campaign
      const eventsByCampaign = {};
      for (const event of this.eventChain) {
        if (!eventsByCampaign[event.campaignId]) {
          eventsByCampaign[event.campaignId] = [];
        }
        eventsByCampaign[event.campaignId].push(event);
      }

      const results = [];

      for (const [campaignId, events] of Object.entries(eventsByCampaign)) {
        const impressions = events.filter(e => e.type === 'impression').length;
        const clicks = events.filter(e => e.type === 'click').length;
        const campaignUsers = new Set(events.map(e => e.userAddress).filter(Boolean));
        const reach = campaignUsers.size;

        // Create batch data structure
        const batch = {
          type: 'adnet-event-batch',
          version: '1.0.0',
          campaignId,
          events: events.map(e => ({
            type: e.type,
            promotionId: e.promotionId,
            userAddress: e.userAddress,
            timestamp: e.timestamp,
            hash: e.hash,
            previousHash: e.previousHash,
            chainIndex: e.chainIndex
          })),
          summary: {
            impressions,
            clicks,
            reach,
            total: events.length
          },
          chain: {
            lastHash: this.lastHash,
            length: events.length
          },
          publisher: {
            domain: window.location.hostname,
            address: this.userAddress
          },
          timestamp: new Date().toISOString()
        };

        // Upload to IPFS
        const ipfsResult = await this.uploadToIPFS(batch);

        if (ipfsResult) {
          console.log(`[Adnet] Campaign ${campaignId}: ${events.length} events uploaded to IPFS: ${ipfsResult.hash}`);

          // Submit to contract
          const txResult = await this.submitToContract(
            ipfsResult.hash,
            campaignId,
            impressions,
            clicks,
            reach
          );

          // Record flush in history
          this.flushHistory.push({
            timestamp: new Date().toISOString(),
            campaignId,
            impressions,
            clicks,
            reach,
            ipfsHash: ipfsResult.hash,
            ipfsUrl: ipfsResult.url,
            txHash: txResult?.txHash || null,
            success: !!ipfsResult
          });

          results.push({
            campaignId,
            impressions,
            clicks,
            reach,
            ipfsHash: ipfsResult.hash,
            success: true
          });
        } else {
          console.error(`[Adnet] Campaign ${campaignId}: Failed to upload to IPFS`);
          results.push({ campaignId, success: false, error: 'IPFS upload failed' });
        }
      }

      // Clear chain after flush
      this.eventChain = [];
      this.lastHash = await this.sha256(Date.now().toString());
      // Note: uniqueUsers is NOT cleared - cumulative reach
      this.saveState();

      console.log('[Adnet] Flush complete');
      return results;
    }

    /**
     * Setup handler to flush on page unload
     */
    setupUnloadHandler() {
      window.addEventListener('beforeunload', async (e) => {
        if (this.eventChain.length > 0) {
          // Use sendBeacon for reliable delivery during unload
          // For now, just save state - flush will happen on next page load
          this.saveState();
          console.log('[Adnet] State saved before unload');
        }
      });

      // Also try to flush when page becomes hidden (more reliable than unload)
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden' && this.eventChain.length > 0) {
          // Try to flush - may not complete if tab is closed quickly
          await this.flushEvents();
        }
      });
    }

    /**
     * Fetch available campaigns from server
     */
    async fetchCampaigns() {
      try {
        const response = await fetch(`${AGENT_BASE}/campaigns`);
        const data = await response.json();

        if (data.status === 'success') {
          this.campaigns = data.campaigns;
          console.log(`[Adnet] Loaded ${this.campaigns.length} campaigns`);
        }
      } catch (error) {
        console.error('[Adnet] Failed to fetch campaigns:', error);
      }
    }

    /**
     * Get campaign details
     */
    async getCampaignDetails(campaignId) {
      try {
        const response = await fetch(`${AGENT_BASE}/campaigns/${campaignId}`);
        if (!response.ok) {
          console.error('[Adnet] Failed to fetch campaign details:', response.status);
          return null;
        }
        return await response.json();
      } catch (error) {
        console.error('[Adnet] Failed to fetch campaign details:', error);
        return null;
      }
    }

    /**
     * Find and populate ad slots
     */
    populateAdSlots() {
      const adSlots = document.querySelectorAll('.adnet-entry');

      if (adSlots.length === 0) {
        console.log('[Adnet] No ad slots found');
        return;
      }

      console.log(`[Adnet] Found ${adSlots.length} ad slots`);

      adSlots.forEach((slot, index) => {
        this.renderAd(slot, index);
      });
    }

    /**
     * Render an ad in a slot
     */
    async renderAd(slotElement, slotIndex) {
      if (this.campaigns.length === 0) {
        console.log('[Adnet] No campaigns available');
        return;
      }

      // Select a random campaign
      const campaign = this.campaigns[Math.floor(Math.random() * this.campaigns.length)];

      // Get full campaign details with promotions
      const campaignDetails = await this.getCampaignDetails(campaign.id);

      if (!campaignDetails || !campaignDetails.promotions || campaignDetails.promotions.length === 0) {
        console.log('[Adnet] Campaign has no promotions');
        return;
      }

      // Select a random promotion
      const promotion = campaignDetails.promotions[
        Math.floor(Math.random() * campaignDetails.promotions.length)
      ];

      // Determine ad type from slot classes
      const isBanner = slotElement.classList.contains('adnet-entry-banner');
      const isSquare = slotElement.classList.contains('adnet-entry-square');
      const isCard = slotElement.classList.contains('adnet-entry-card');

      // Build ad HTML
      const adHtml = this.buildAdHtml(campaignDetails, promotion, { isBanner, isSquare, isCard });

      slotElement.innerHTML = adHtml;
      slotElement.dataset.campaignId = campaign.id;
      slotElement.dataset.promotionId = promotion.promotionId;

      // Track rendered ad
      this.renderedAds.set(slotIndex, {
        campaignId: campaign.id,
        promotionId: promotion.promotionId,
        landingUrl: campaignDetails.landingUrl
      });

      // Record impression event
      await this.recordEvent(campaign.id, promotion.promotionId, 'impression');

      // Attach click handler
      const clickTarget = slotElement.querySelector('.adnet-clickable');
      if (clickTarget) {
        clickTarget.addEventListener('click', async (e) => {
          e.preventDefault();
          await this.handleAdClick(campaign.id, promotion.promotionId, campaignDetails.landingUrl);
        });
      }

      console.log(`[Adnet] Rendered ad for campaign ${campaign.id}, promotion ${promotion.promotionId}`);
    }

    /**
     * Build ad HTML
     */
    buildAdHtml(campaign, promotion, options = {}) {
      const { isBanner, isSquare, isCard } = options;
      const ipfsGateway = CONFIG.ipfsGateway + '/ipfs/';

      if (isBanner) {
        return `
          <div class="adnet-banner">
            <a href="#" class="adnet-clickable" style="display: flex; align-items: center; text-decoration: none; color: inherit; width: 100%;">
              <img src="${ipfsGateway}${promotion.creative}" alt="${promotion.title}" style="height: 90px; width: auto; margin-right: 20px;">
              <div style="flex: 1;">
                <div style="font-size: 18px; font-weight: bold; margin-bottom: 5px;">${promotion.title}</div>
                ${promotion.subtitle ? `<div style="font-size: 14px; color: #666;">${promotion.subtitle}</div>` : ''}
                <div style="font-size: 11px; color: #999; margin-top: 5px;">Sponsored</div>
              </div>
            </a>
          </div>
        `;
      }

      if (isSquare) {
        return `
          <div class="adnet-square" style="width: 300px; height: 250px; border: 1px solid #ddd; overflow: hidden;">
            <a href="#" class="adnet-clickable" style="display: block; text-decoration: none; color: inherit;">
              <img src="${ipfsGateway}${promotion.creative}" alt="${promotion.title}" style="width: 100%; height: 150px; object-fit: cover;">
              <div style="padding: 10px;">
                <div style="font-size: 14px; font-weight: bold; margin-bottom: 5px;">${promotion.title}</div>
                ${promotion.subtitle ? `<div style="font-size: 12px; color: #666; margin-bottom: 5px;">${promotion.subtitle}</div>` : ''}
                <div style="font-size: 10px; color: #999;">Sponsored</div>
              </div>
            </a>
          </div>
        `;
      }

      if (isCard) {
        return `
          <div class="adnet-card" style="border: 1px solid #ddd; padding: 15px; margin-bottom: 20px;">
            <a href="#" class="adnet-clickable" style="display: flex; text-decoration: none; color: inherit;">
              <img src="${ipfsGateway}${promotion.creative}" alt="${promotion.title}" style="width: 200px; height: 150px; object-fit: cover; margin-right: 15px;">
              <div style="flex: 1;">
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 10px;">${promotion.title}</div>
                ${promotion.subtitle ? `<div style="font-size: 14px; color: #666; margin-bottom: 10px;">${promotion.subtitle}</div>` : ''}
                <div style="font-size: 11px; color: #999;">Sponsored by ${campaign.brand}</div>
              </div>
            </a>
          </div>
        `;
      }

      // Default
      return `
        <div class="adnet-default">
          <a href="#" class="adnet-clickable" style="display: block; text-decoration: none; color: inherit;">
            <img src="${ipfsGateway}${promotion.creative}" alt="${promotion.title}" style="max-width: 100%; height: auto;">
            <div style="padding: 10px;">
              <div style="font-weight: bold;">${promotion.title}</div>
              ${promotion.subtitle ? `<div style="color: #666;">${promotion.subtitle}</div>` : ''}
              <div style="font-size: 11px; color: #999; margin-top: 5px;">Sponsored</div>
            </div>
          </a>
        </div>
      `;
    }

    /**
     * Handle ad click
     */
    async handleAdClick(campaignId, promotionId, landingUrl) {
      console.log('[Adnet] Ad clicked');

      // Record click event
      await this.recordEvent(campaignId, promotionId, 'click');

      // Navigate to landing page
      setTimeout(() => {
        window.location.href = landingUrl;
      }, 100);
    }
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      new AdnetClient();
    });
  } else {
    new AdnetClient();
  }

})();
