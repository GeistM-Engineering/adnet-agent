/**
 * Adnet Agent Client
 *
 * Browser-side script that identifies ad placeholders,
 * fetches campaigns, renders ads, and tracks events.
 */

(async function() {
  'use strict';

  // Determine the base URL of this script
  const scriptUrl = new URL(document.currentScript.src);
  const EPISTERY_BASE = `${scriptUrl.protocol}//${scriptUrl.host}`;
  const AGENT_BASE = `${EPISTERY_BASE}/agent/geistm/adnet-agent`;

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
      this.renderedAds = new Map(); // Track which ads have been rendered
      this.userAddress = null;
      this.witness = null;
      this.lastWidth = window.innerWidth;
      this.init();
    }

    async init() {
      console.log('[Adnet] Initializing agent client');

      await this.connectEpistery();
      await this.fetchCampaigns();
      this.populateAdSlots();

      window.addEventListener('resize', () => {
        if (Math.abs(window.innerWidth - this.lastWidth) > 50) {
          this.lastWidth = window.innerWidth;
          this.populateAdSlots();
        }
      });
    }

    async connectEpistery() {
      if (!Witness) {
        console.log('[Adnet] Epistery not available, user tracking disabled');
        return;
      }

      try {
        this.witness = await Witness.connect({ rootPath: EPISTERY_BASE });
        const status = this.witness.getStatus();
        if (status.client?.address) {
          this.userAddress = status.client.address;
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
        if (!response.ok) {
          console.error('[Adnet] Failed to fetch campaign details:', response.status);
          return null;
        }
        const data = await response.json();
        return data;
      } catch (error) {
        console.error('[Adnet] Failed to fetch campaign details:', error);
        return null;
      }
    }

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

    async renderAd(slotElement, slotIndex) {
      if (this.campaigns.length === 0) return;

      // 1. DYNAMIC SENSING: Measure the slot
      const width = slotElement.offsetWidth;
      const isVertical = width < 220; // Side Rails
      const isWide = width > 500;     // Article Banners

      // Select Campaign & Promotion
      const campaign = this.campaigns[Math.floor(Math.random() * this.campaigns.length)];
      const details = await this.getCampaignDetails(campaign.id);
      if (!details?.promotions?.length) return;
      const promotion = details.promotions[Math.floor(Math.random() * details.promotions.length)];

      // Determine Placement Info
      const placementType = isVertical ? 'vertical' : (isWide ? 'horizontal' : 'rectangle');
      const placementId = slotElement.dataset.placementId || `${placementType}-${slotIndex}`;
      const placement = { id: placementId, type: placementType, pageUrl: window.location.pathname };

      // 2. BUILD HTML (Dynamic Layout)
      slotElement.innerHTML = this.buildDynamicHtml(details, promotion, { isVertical, isWide });

      // 3. TRACKING & EVENTS
      const landingUrl = promotion.landingUrl || details.landingUrl;
      this.renderedAds.set(slotIndex, { campaignId: campaign.id, promotionId: promotion.promotionId, landingUrl, placement });

      await this.recordEvent(campaign.id, promotion.promotionId, 'view', placement);

      const clickTarget = slotElement.querySelector('.adnet-clickable');
      if (clickTarget) {
        clickTarget.onclick = async (e) => {
          e.preventDefault();
          await this.handleAdClick(campaign.id, promotion.promotionId, landingUrl, placement);
        };
      }
    }

    buildDynamicHtml(campaign, promotion, context) {
      const { isVertical, isWide } = context;
      const ipfsGateway = 'https://ipfs.io/ipfs/';
      // Use creative URL directly if it's already a full URL, otherwise prepend IPFS gateway
      const creativeUrl = promotion.creative.startsWith('http://') || promotion.creative.startsWith('https://')
        ? promotion.creative
        : `${ipfsGateway}${promotion.creative}`;

      const wrapperStyle = "width: 100%; text-decoration: none; color: inherit; display: block; border: 1px solid #ddd; background: #fff;";

      const renderText = (text, style) => {
        if (!text || text.trim() === "") return "";
        return `<div style="${style}">${text}</div>`;
      };

      if (isVertical) {
        // Skyscraper / Side Rail layout (Tall)
        return `
          <a href="#" class="adnet-clickable" style="${wrapperStyle}">
            <div style="width: 100%; aspect-ratio: 160 / 300; overflow: hidden; background: #000;">
              <img src="${creativeUrl}" style="width: 100%; height: 100%; object-fit: cover;">
            </div>
            <div style="padding: 12px;">
              ${renderText(promotion.title, "font-size: 14px; font-weight: bold; margin-bottom: 5px;")}
              <div style="font-size: 10px; color: #999;">Sponsored</div>
            </div>
          </a>`;
      }

      if (isWide) {
        // Horizontal Article Banner layout
        return `
          <a href="#" class="adnet-clickable" style="${wrapperStyle} display: flex; align-items: center; padding: 10px;">
            <img src="${creativeUrl}" style="height: 60px; width: auto; max-width: 40%; object-fit: contain; margin-right: 15px;">
            <div style="flex: 1;">
              ${renderText(promotion.title, "font-size: 16px; font-weight: bold;")}
              ${renderText(promotion.subtitle, "font-size: 13px; color: #666;")}
              <div style="font-size: 10px; color: #999;">Sponsored</div>
            </div>
          </a>`;
      }

      // Default / Rectangle layout
      return `
        <a href="#" class="adnet-clickable" style="${wrapperStyle}">
          <div style="width: 100%; aspect-ratio: 16 / 9; overflow: hidden;">
            <img src="${creativeUrl}" style="width: 100%; height: 100%; object-fit: cover;">
          </div>
          <div style="padding: 15px;">
            ${renderText(promotion.title, "font-size: 15px; font-weight: bold;")}
            <div style="font-size: 11px; color: #999;">Sponsored by ${campaign.brand || 'Partner'}</div>
          </div>
        </a>`;
    }

    async recordEvent(campaignId, promotionId, type, placement = null) {
      try {
        const timestamp = Date.now();
        let signature = null;
        let notabotScore = null;

        // Sign the event if wallet is available (cryptographic proof of identity)
        if (this.witness?.wallet && this.userAddress) {
          try {
            const message = `adnet:${campaignId}:${type}:${timestamp}`;
            signature = await this.witness.wallet.sign(message, window.ethers);
          } catch (signError) {
            console.warn('[Adnet] Failed to sign event:', signError);
          }
        }

        // Get notabot score if available (proof of human)
        if (this.witness?.notabot) {
          try {
            notabotScore = this.witness.notabot.getScore();
          } catch (notabotError) {
            console.warn('[Adnet] Failed to get notabot score:', notabotError);
          }
        }

        const response = await fetch(`${AGENT_BASE}/record`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            campaignId,
            promotionId,
            type,
            timestamp,
            userAddress: this.userAddress,
            signature,
            notabotScore,
            placement
          })
        });

        const data = await response.json();

        if (data.status === 'success') {
          console.log(`[Adnet] ${type} event recorded (verified: ${data.verified}, notabot: ${notabotScore?.points || 0})`);
          if (data.chainLength >= data.threshold) {
            console.log('[Adnet] Threshold reached, events will be posted to contract');
          }
        }
      } catch (error) {
        console.error(`[Adnet] Failed to record ${type} event:`, error);
      }
    }

    async handleAdClick(campaignId, promotionId, landingUrl, placement = null) {
      console.log('[Adnet] Ad clicked');

      // Record click event with placement info
      await this.recordEvent(campaignId, promotionId, 'click', placement);

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