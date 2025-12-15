import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Adnet Agent - Server Component
 *
 * Minimal server that:
 * - Serves the browser-side client.js
 * - Proxies campaign data from factory
 * - Provides health/status endpoints
 *
 * All event batching, IPFS uploads, and contract submissions
 * happen in the browser (client.js).
 */
export default class AdnetAgent {
  constructor(config = {}) {
    this.config = config;
    this.epistery = null;

    // Factory configuration
    this.factoryUrl = config.factoryUrl || 'https://adnet.geistm.com';

    // Campaign cache
    this.campaignsCache = [];
    this.cacheExpiry = 0;
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes

    console.log('[adnet] Agent initialized');
    console.log('[adnet] Factory URL:', this.factoryUrl);
  }

  /**
   * Fetch available campaigns from factory
   */
  async fetchCampaigns() {
    if (Date.now() < this.cacheExpiry && this.campaignsCache.length > 0) {
      return this.campaignsCache;
    }

    try {
      const response = await fetch(`${this.factoryUrl}/api/ads?active=true`);
      const data = await response.json();

      if (data.status === 'success') {
        this.campaignsCache = data.contracts || [];
        this.cacheExpiry = Date.now() + this.cacheDuration;
        console.log(`[adnet] Cached ${this.campaignsCache.length} campaigns from factory`);
        return this.campaignsCache;
      }
      return [];
    } catch (error) {
      console.error('[adnet] Failed to fetch campaigns:', error.message);
      return [];
    }
  }

  /**
   * Attach agent routes to Express router
   */
  attach(router) {
    // Get epistery instance from app.locals
    router.use((req, res, next) => {
      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;
        console.log('[adnet] Epistery instance attached');
      }
      next();
    });

    // Redirect root to status
    router.get('/', (req, res) => {
      res.redirect(req.baseUrl + '/status');
    });

    // Serve static files
    router.use(express.static(path.join(__dirname, 'public')));

    // Client script (browser agent)
    router.get('/client.js', (req, res) => {
      res.sendFile(path.join(__dirname, 'client', 'client.js'));
    });

    // Serve icon
    router.get('/icon.webp', (req, res) => {
      const iconPath = path.join(__dirname, 'icon.webp');
      if (!existsSync(iconPath)) {
        return res.status(404).send('Icon not found');
      }
      res.sendFile(iconPath);
    });

    // Serve widget
    router.get('/widget', (req, res) => {
      const widgetPath = path.join(__dirname, 'client', 'widget.html');
      if (!existsSync(widgetPath)) {
        return res.status(404).send('Widget not found');
      }
      res.sendFile(widgetPath);
    });

    // Serve admin page
    router.get('/admin', (req, res) => {
      const adminPath = path.join(__dirname, 'client', 'admin.html');
      if (!existsSync(adminPath)) {
        return res.status(404).send('Admin page not found');
      }
      res.sendFile(adminPath);
    });

    // Serve sponsor page
    router.get('/sponsor', (req, res) => {
      const sponsorPath = path.join(__dirname, 'client', 'sponsor.html');
      if (!existsSync(sponsorPath)) {
        return res.status(404).send('Sponsor page not found');
      }
      res.sendFile(sponsorPath);
    });

    // Serve publisher page
    router.get('/publisher', (req, res) => {
      const publisherPath = path.join(__dirname, 'client', 'publisher.html');
      if (!existsSync(publisherPath)) {
        return res.status(404).send('Publisher page not found');
      }
      res.sendFile(publisherPath);
    });

    // Get campaigns (proxied from factory)
    router.get('/campaigns', async (req, res) => {
      const campaigns = await this.fetchCampaigns();
      res.json({ status: 'success', campaigns, count: campaigns.length });
    });

    // Get individual campaign details (proxied from factory)
    router.get('/campaigns/:campaignId', async (req, res) => {
      const { campaignId } = req.params;
      console.log(`[adnet] Fetching campaign details for: ${campaignId}`);

      // Check cache first
      const cached = this.campaignsCache.find(c => c.id === campaignId);
      if (cached) {
        return res.json(cached);
      }

      // Fetch from factory
      try {
        const response = await fetch(`${this.factoryUrl}/api/campaign/${campaignId}`);
        if (!response.ok) {
          return res.status(response.status).json({ error: 'Campaign not found' });
        }
        const data = await response.json();
        res.json(data.contract || data);
      } catch (error) {
        console.error(`[adnet] Failed to fetch campaign ${campaignId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch campaign details' });
      }
    });

    // Get contract report from factory
    router.get('/campaigns/:campaignId/report', async (req, res) => {
      const { campaignId } = req.params;
      console.log(`[adnet] Fetching contract report for: ${campaignId}`);

      try {
        const response = await fetch(`${this.factoryUrl}/api/campaign/${campaignId}/report`, {
          headers: {
            'Authorization': req.headers.authorization || ''
          }
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Failed to fetch report' }));
          return res.status(response.status).json(error);
        }

        const data = await response.json();
        res.json(data);
      } catch (error) {
        console.error(`[adnet] Failed to fetch report for ${campaignId}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch campaign report' });
      }
    });

    // Status endpoint
    router.get('/status', (req, res) => {
      res.json({
        status: 'success',
        agent: 'adnet-agent',
        version: '2.0.0',
        mode: 'browser-side',
        description: 'Event batching and IPFS uploads happen in the browser',
        factory: { url: this.factoryUrl },
        campaigns: { cached: this.campaignsCache.length }
      });
    });

    // Health check
    router.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        factoryUrl: this.factoryUrl
      });
    });

    // API health (for widget/admin)
    router.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        agent: 'adnet-agent',
        version: '2.0.0',
        mode: 'browser-side',
        config: {
          factoryUrl: this.factoryUrl
        }
      });
    });

    console.log('[adnet] Agent routes attached');
    return this;
  }

  /**
   * Cleanup on shutdown
   */
  async cleanup() {
    console.log('[adnet] Cleanup complete');
  }
}
