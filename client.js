/**
 * Adnet Agent Client
 *
 * Browser-side script that identifies ad placeholders,
 * fetches campaigns, renders ads, and tracks events.
 */

(async function() {
  'use strict';

  const AGENT_BASE = '/.well-known/epistery/agent/adnet';

  let Witness;
  try {
    const module = await import('/.well-known/epistery/lib/witness.js');
    Witness = module.default;
  } catch (error) {
    console.warn('[Adnet] Failed to load Epistery Witness:', error);
  }

  class AdnetClient {
    constructor() {
      this.campaigns = [];
      this.renderedAds = new Map(); // Track which ads have been rendered
      this.userAddress = null;
      this.witness = null;
      this.init();
    }

    async init() {
      console.log('[Adnet] Initializing agent client');

      this.connectEpistery();

      // Fetch available campaigns
      await this.fetchCampaigns();

      // Find and populate ad placeholders
      this.populateAdSlots();
    }

    async connectEpistery() {
      if (!Witness) {
        console.log('[Adnet] Epistery not available, user tracking disabled');
        return;
      }

      try {
        this.witness = await Witness.connect();
        const status = this.witness.getStatus();

        if (status.client && status.client.address) {
          this.userAddress = status.client.address;
          console.log('[Adnet] User wallet connected:', this.userAddress);
        } else {
          console.log('[Adnet] No user wallet found');
        }
      } catch (error) {
        console.warn('[Adnet] Failed to connect to Epistery:', error);
      }
    }

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

    async getCampaignDetails(campaignId) {
      try {
        const response = await fetch(`${AGENT_BASE}/campaigns/${campaignId}`);
        const data = await response.json();

        if (data.status === 'success') {
          return data.campaign;
        }
      } catch (error) {
        console.error('[Adnet] Failed to fetch campaign details:', error);
      }
      return null;
    }

    populateAdSlots() {
      // Find all divs with class 'adnet-entry'
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

      // Track that we've rendered this ad
      this.renderedAds.set(slotIndex, {
        campaignId: campaign.id,
        promotionId: promotion.promotionId,
        landingUrl: campaignDetails.landingUrl
      });

      // Record view event
      await this.recordEvent(campaign.id, promotion.promotionId, 'view');

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

    buildAdHtml(campaign, promotion, options = {}) {
      const { isBanner, isSquare, isCard } = options;
      const ipfsGateway = 'https://ipfs.io/ipfs/'; // TODO: Use configured IPFS gateway

      // Banner ad (728x90 or responsive)
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

      // Square ad (300x250)
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

      // Card ad (similar to article preview)
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

      // Default ad rendering
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

    async recordEvent(campaignId, promotionId, type) {
      try {
        const response = await fetch(`${AGENT_BASE}/record`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            campaignId,
            promotionId,
            type,
            userAddress: this.userAddress // User wallet address from Epistery
          })
        });

        const data = await response.json();

        if (data.status === 'success') {
          console.log(`[Adnet] ${type} event recorded:`, data.event);
          if (data.chainLength >= data.threshold) {
            console.log('[Adnet] Threshold reached, events will be posted to contract');
          }
        }
      } catch (error) {
        console.error(`[Adnet] Failed to record ${type} event:`, error);
      }
    }

    async handleAdClick(campaignId, promotionId, landingUrl) {
      console.log('[Adnet] Ad clicked');

      // Record click event
      await this.recordEvent(campaignId, promotionId, 'click');

      // Navigate to landing page after a brief delay (to ensure event is recorded)
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
