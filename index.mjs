import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Adnet Agent - Publisher-side component
 *
 * Follows epistery-host plugin architecture:
 * - Constructor receives config from manifest
 * - Gets epistery instance from app.locals
 * - attach(router) called by AgentManager
 * - cleanup() called on shutdown
 */
export default class AdnetAgent {
  constructor(config = {}) {
    this.config = config;
    this.epistery = null;

    this.threshold = config.threshold || 5;
    this.factoryUrl = config.factoryUrl || 'https://adnet.geistm.com';

    // Hash chain for transaction batching
    this.eventChain = [];
    this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

    // Cache of available campaigns
    this.campaignsCache = [];
    this.cacheExpiry = 0;
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes

    console.log('[adnet] Agent initialized');
    console.log('[adnet] Threshold:', this.threshold);
  }

  /**
   * Create a hash of transaction data
   */
  hashEvent(event) {
    const data = JSON.stringify({
      ...event,
      previousHash: this.lastHash
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Add event to the chain
   */
  addEventToChain(event) {
    const hash = this.hashEvent(event);
    const chainedEvent = {
      ...event,
      hash,
      previousHash: this.lastHash,
      chainIndex: this.eventChain.length
    };

    this.eventChain.push(chainedEvent);
    this.lastHash = hash;

    console.log(`[adnet] Event added. Chain: ${this.eventChain.length}/${this.threshold}`);

    // Check if we've reached threshold
    if (this.eventChain.length >= this.threshold) {
      this.flushEvents();
    }

    return chainedEvent;
  }

  /**
   * Post batched events to campaign contract
   */
  async flushEvents() {
    if (this.eventChain.length === 0) return;

    const factoryUrl = this.factoryUrl || this.epistery?.domain?.config?.adnet?.factoryUrl || 'https://adnet.geistm.com';
    console.log(`[adnet] Flushing ${this.eventChain.length} events`);

    // Group events by campaign
    const eventsByCampaign = {};
    for (const event of this.eventChain) {
      if (!eventsByCampaign[event.campaignId]) {
        eventsByCampaign[event.campaignId] = [];
      }
      eventsByCampaign[event.campaignId].push(event);
    }

    // Post to each campaign
    const results = [];
    for (const [campaignId, events] of Object.entries(eventsByCampaign)) {
      try {
        const response = await fetch(`${factoryUrl}/api/campaign/${campaignId}/record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events })
        });

        const result = await response.json();
        results.push({ campaignId, success: result.status === 'success', result });
        console.log(`[adnet] Posted ${events.length} events to campaign ${campaignId}`);
      } catch (error) {
        console.error(`[adnet] Failed to post to campaign ${campaignId}:`, error.message);
        results.push({ campaignId, success: false, error: error.message });
      }
    }

    // Clear the chain
    this.eventChain = [];
    this.lastHash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');

    return results;
  }

  /**
   * Fetch available campaigns from factory
   */
  async fetchCampaigns() {
    if (Date.now() < this.cacheExpiry && this.campaignsCache.length > 0) {
      return this.campaignsCache;
    }

    try {
      const factoryUrl = this.factoryUrl || 'https://adnet.geistm.com';
      const response = await fetch(`${factoryUrl}/api/ads?active=true`);
      const data = await response.json();

      if (data.status === 'success') {
        this.campaignsCache = data.contracts || [];
        this.cacheExpiry = Date.now() + this.cacheDuration;
        return this.campaignsCache;
      }
      return [];
    } catch (error) {
      console.error('[adnet] Failed to fetch campaigns:', error.message);
      return [];
    }
  }

  /**
   * Verify delegation token from request (epistery pattern)
   */
  async verifyDelegationToken(req) {
    const delegationHeader = req.headers['x-epistery-delegation'];
    const delegationCookie = req.cookies?.epistery_delegation;
    const tokenData = delegationHeader || delegationCookie;

    if (!tokenData) {
      return { valid: false };
    }

    try {
      const token = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
      const { delegation, signature } = token;

      if (!delegation || !signature) {
        return { valid: false, error: 'Invalid token structure' };
      }

      if (Date.now() > delegation.expires) {
        return { valid: false, error: 'Token expired' };
      }

      const requestDomain = req.hostname || req.get('host')?.split(':')[0];
      if (delegation.audience !== requestDomain) {
        return { valid: false, error: 'Token audience mismatch' };
      }

      return {
        valid: true,
        address: delegation.subject,
        domain: delegation.audience,
        scope: delegation.scope
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Attach agent routes to Express router
   * Called by AgentManager after instantiation
   */
  attach(router) {
    // Get epistery instance from app.locals (epistery pattern)
    router.use((req, res, next) => {
      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;
        console.log('[adnet] Epistery instance attached');
      }
      next();
    });

    // Static files
    router.use(express.static(path.join(__dirname, 'public')));

    // Client script
    router.get('/client.js', (req, res) => {
      res.sendFile(path.join(__dirname, 'client', 'client.js'));
    });

    // Get campaigns
    router.get('/campaigns', async (req, res) => {
      const campaigns = await this.fetchCampaigns();
      res.json({ status: 'success', campaigns, count: campaigns.length });
    });

    // Get individual campaign details
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

    // Record event (view or click)
    router.post('/record', async (req, res) => {
      try {
        const { campaignId, promotionId, type } = req.body;

        if (!campaignId || !type) {
          return res.status(400).json({ status: 'error', message: 'campaignId and type required' });
        }

        if (!['view', 'click'].includes(type)) {
          return res.status(400).json({ status: 'error', message: 'type must be view or click' });
        }

        // Check delegation (optional - anonymous OK)
        const verification = await this.verifyDelegationToken(req);

        const event = {
          campaignId,
          promotionId,
          type,
          userAddress: verification.valid ? verification.address : null,
          userVerified: verification.valid,
          timestamp: new Date().toISOString()
        };

        const chainedEvent = this.addEventToChain(event);

        res.json({
          status: 'success',
          event: { hash: chainedEvent.hash, chainIndex: chainedEvent.chainIndex },
          chainLength: this.eventChain.length,
          threshold: this.threshold
        });
      } catch (error) {
        console.error('[adnet] Record error:', error);
        res.status(500).json({ status: 'error', message: error.message });
      }
    });

    // Status
    router.get('/status', (req, res) => {
      res.json({
        status: 'success',
        chain: {
          length: this.eventChain.length,
          threshold: this.threshold,
          lastHash: this.lastHash
        },
        factory: { url: this.factoryUrl }
      });
    });

    // Manual flush
    router.post('/flush', async (req, res) => {
      const results = await this.flushEvents();
      res.json({ status: 'success', results });
    });

    // Health check
    router.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        pendingEvents: this.eventChain.length,
        factoryUrl: this.factoryUrl
      });
    });

    console.log('[adnet] Agent routes attached');
    return this;
  }

  /**
   * Cleanup on shutdown
   */
  async cleanup() {
    if (this.eventChain.length > 0) {
      console.log('[adnet] Flushing events on shutdown');
      await this.flushEvents();
    }
    console.log('[adnet] Cleanup complete');
  }
}
