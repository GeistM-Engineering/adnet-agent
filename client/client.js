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
      this.detailsCache = new Map();
      this.userAddress = null;
      this.witness = null;
      this.lastWidth = window.innerWidth;
      this.init();
    }

    async init() {
      console.log('[Adnet] Initializing Universal Agent');

      await this.connectEpistery();
      await this.fetchCampaigns();
      
      // Step A: Auto-find whitespace and inject slots (Site-Agnostic)
      this.autoInjectSlots();
      
      // Step B: Render ads into all slots (manual or auto-injected)
      this.populateAdSlots();

      // Step C: Listen for resizing (50px threshold to prevent excessive firing)
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
          console.log('[Adnet] User connected:', this.userAddress);
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

    async getCachedDetails(id) {
      if (this.detailsCache.has(id)) return this.detailsCache.get(id);
      try {
        const response = await fetch(`${AGENT_BASE}/campaigns/${id}`);
        const data = await response.json();
        if (data) this.detailsCache.set(id, data);
        return data;
      } catch (error) {
        console.error('[Adnet] Failed to fetch campaign details:', error);
        return null;
      }
    }

    /**
     * UNIVERSAL WHITESPACE SENSING
     * Scans the page for content containers and injects ad slots 
     * where they will look most like native "Recommended" content.
     */
    autoInjectSlots() {
      const contentSelectors = ['article', '.post-content', '.entry-content', 'main', '#content', '.content-area'];
      let container = null;
      for (const selector of contentSelectors) {
        container = document.querySelector(selector);
        if (container) break;
      }

      // 1. In-Article Native Injection
      if (container && !document.getElementById('adnet-auto-article')) {
        const paragraphs = container.querySelectorAll('p');
        if (paragraphs.length > 3) {
          const midAd = document.createElement('div');
          midAd.id = 'adnet-auto-article';
          midAd.className = 'adnet-entry';
          midAd.style.margin = '30px 0';
          // Insert after 2nd paragraph for maximum visibility
          paragraphs[1].parentNode.insertBefore(midAd, paragraphs[1].nextSibling);
        }
      }

      // 2. Sidebar Rail Injection (Desktop Only)
      if (window.innerWidth > 1250 && !document.getElementById('adnet-left-rail')) {
        const leftSpace = container ? container.getBoundingClientRect().left : 0;
        if (leftSpace > 180) {
          const rail = document.createElement('div');
          rail.id = 'adnet-left-rail';
          rail.className = 'adnet-entry';
          rail.style.cssText = `position:fixed; left:15px; top:180px; width:160px; z-index:100;`;
          document.body.appendChild(rail);
        }
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
  
      // 1. STYLE SENSING
      // Find a nearby heading or paragraph to copy styles from
      const sampleText = document.querySelector('h1, h2, h3, .entry-title, .post-title') || slotElement.parentElement;
      const computed = window.getComputedStyle(sampleText);
      
      const siteStyles = {
          fontFamily: computed.fontFamily,
          titleColor: computed.color,
          fontSize: computed.fontSize,
          lineHeight: computed.lineHeight
      };
  
      const width = slotElement.offsetWidth || 300;
      const isVertical = width < 220;
      const isWide = width > 500;
  
      // 2. AD SELECTION
      let selectedPromo = null;
      let selectedCampaign = null;
      const existingId = slotElement.dataset.campaignId;
      const existingPromoId = slotElement.dataset.promotionId;
  
      if (existingId && existingPromoId) {
          selectedCampaign = await this.getCachedDetails(existingId);
          selectedPromo = selectedCampaign?.promotions?.find(p => p.promotionId === existingPromoId);
      }
  
      if (!selectedPromo) {
          const shuffled = [...this.campaigns].sort(() => 0.5 - Math.random());
          for (const camp of shuffled) {
              const details = await this.getCachedDetails(camp.id);
              const valid = details?.promotions?.find(p => p.title && p.title.trim() !== "");
              if (valid) {
                  selectedPromo = valid;
                  selectedCampaign = details;
                  break;
              }
          }
      }
  
      if (!selectedPromo) return;
  
      // 3. INJECT
      slotElement.dataset.campaignId = selectedCampaign.id;
      slotElement.dataset.promotionId = selectedPromo.promotionId;
      
      // Pass siteStyles into the HTML builder
      slotElement.innerHTML = this.buildDynamicHtml(selectedCampaign, selectedPromo, { isVertical, isWide, siteStyles });
  
      // 4. VIEWABILITY (Intersection Observer)
      if (!slotElement.dataset.viewed) {
          const observer = new IntersectionObserver((entries) => {
              entries.forEach(entry => {
                  if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                      this.recordEvent(selectedCampaign.id, selectedPromo.promotionId, 'view', { id: slotElement.id || `slot-${slotIndex}`, type: isVertical ? 'vertical' : 'native' });
                      slotElement.dataset.viewed = "true";
                      observer.unobserve(slotElement);
                  }
              });
          }, { threshold: 0.5 });
          observer.observe(slotElement);
      }
  
      // 5. CLICK HANDLER
      const clickTarget = slotElement.querySelector('.adnet-clickable');
      if (clickTarget) {
        clickTarget.onclick = async (e) => {
          e.preventDefault();
          const url = selectedPromo.landingUrl || selectedCampaign.landingUrl;
          await this.handleAdClick(selectedCampaign.id, selectedPromo.promotionId, url);
        };
      }
    }

    buildDynamicHtml(campaign, promotion, context) {
      const { isVertical, isWide, siteStyles } = context;
      const creativeUrl = promotion.creative.startsWith('http') ? promotion.creative : `https://ipfs.io/ipfs/${promotion.creative}`;

      const wrapperStyle = `width:100%; text-decoration:none; display:block; background:transparent; font-family:${siteStyles.fontFamily}; color:${siteStyles.titleColor};`;
      const titleStyle = `font-weight:bold; line-height:${siteStyles.lineHeight}; font-size:${siteStyles.fontSize}; margin-top:10px; margin-bottom:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;`;
      const subtitleStyle = `opacity:0.7; font-size:0.9em; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;`;
      const sponsorStyle = `font-size:0.7em; opacity:0.5; margin-top:8px; text-transform:uppercase;`;
      return `
        <a href="#" class="adnet-clickable" style="${wrapperStyle}">
          <div style="width:100%; aspect-ratio:16/9; overflow:hidden;">
            <img src="${creativeUrl}" style="width:100%; height:100%; object-fit:cover;">
          </div>
          <div style="padding:0;">
              <div style="${titleStyle}">${promotion.title}</div>
              ${promotion.subtitle ? `<div style="${subtitleStyle}">${promotion.subtitle}</div>` : ''}
              <div style="${sponsorStyle}">Sponsored by ${campaign.brand}</div>
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