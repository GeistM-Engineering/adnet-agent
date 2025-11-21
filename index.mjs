import express from 'express';
import crypto from 'crypto';
import { Epistery, Config } from 'epistery';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Adnet Agent - Publisher-side component
 *
 * The agent manages ad display and event tracking for publishers.
 * It batches events into a hash tree/chain and posts to contracts
 * when threshold is reached.
 */
export default class AdnetAgent {
  constructor(options = {}) {
    this.threshold = options.threshold || 5; // Number of events before posting to contract

    // Hash chain for transaction batching
    this.eventChain = [];
    this.lastHash = '0000000000000000000000000000000000000000000000000000000000000000';

    // Cache of available campaigns
    this.campaignsCache = [];
    this.cacheExpiry = 0;
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes

    // Initialize Epistery and load config
    this.initEpistery();
  }

  async initEpistery() {
    try {
      const domain = process.argv[2];

      this.config = new Config();
      this.config.setPath(domain); // ~/.epistery/[domain]/config.ini
      this.config.load();

      const rootConfig = new Config();
      rootConfig.load(); // ~/.epistery/config.ini

      this.factoryUrl = rootConfig.data.adnet?.factoryUrl;
      this.publisherAddress = this.config.data.wallet?.address;
      this.domain = domain;

      this.epistery = await Epistery.connect();
      
      console.log('Adnet Agent initialized');
      console.log('Publisher domain:', this.domain);
      console.log('Publisher address:', this.publisherAddress);
      console.log('Factory URL:', this.factoryUrl);
      console.log('Threshold:', this.threshold);
    } catch (error) {
      console.error('Failed to initialize Epistery for agent:', error);
    }
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
      hash: hash,
      previousHash: this.lastHash,
      chainIndex: this.eventChain.length
    };

    this.eventChain.push(chainedEvent);
    this.lastHash = hash;

    console.log(`Event added to chain. Total: ${this.eventChain.length}/${this.threshold}`);

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

    console.log(`Flushing ${this.eventChain.length} events to factory`);

    // Group events by campaign
    const eventsByCampaign = {};
    for (const event of this.eventChain) {
      if (!eventsByCampaign[event.campaignId]) {
        eventsByCampaign[event.campaignId] = [];
      }
      eventsByCampaign[event.campaignId].push({
        type: event.type,
        promotionId: event.promotionId,
        publisher: this.publisherAddress,
        user: event.userAddress,
        timestamp: event.timestamp,
        hash: event.hash,
        previousHash: event.previousHash,
        chainIndex: event.chainIndex
      });
    }

    // Post to each campaign contract
    const results = [];
    for (const [campaignId, events] of Object.entries(eventsByCampaign)) {
      try {
        const response = await fetch(`${this.factoryUrl}/api/campaign/${campaignId}/record`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ events })
        });

        const result = await response.json();
        results.push({ campaignId, success: result.status === 'success', result });
        console.log(`Posted ${events.length} events to campaign ${campaignId}`);
      } catch (error) {
        console.error(`Failed to post events to campaign ${campaignId}:`, error.message);
        results.push({ campaignId, success: false, error: error.message });
      }
    }

    // Clear the chain after posting
    this.eventChain = [];
    this.lastHash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');

    return results;
  }

  /**
   * Fetch available campaigns from factory
   */
  async fetchCampaigns() {
    // Check cache
    if (Date.now() < this.cacheExpiry && this.campaignsCache.length > 0) {
      return this.campaignsCache;
    }

    try {
      const response = await fetch(`${this.factoryUrl}/api/ads?active=true`);
      const data = await response.json();

      if (data.status === 'success') {
        this.campaignsCache = data.contracts || [];
        this.cacheExpiry = Date.now() + this.cacheDuration;
        return this.campaignsCache;
      }

      return [];
    } catch (error) {
      console.error('Failed to fetch campaigns:', error);
      return [];
    }
  }

  /**
   * Get campaign details
   */
  async getCampaign(campaignId) {
    try {
      const response = await fetch(`${this.factoryUrl}/api/campaign/${campaignId}`);
      const data = await response.json();

      if (data.status === 'success') {
        return data.contract;
      }

      return null;
    } catch (error) {
      console.error('Failed to fetch campaign:', error);
      return null;
    }
  }

  /**
   * Attach agent routes to Express app
   */
  attach(app) {
    const router = express.Router();

    // Serve client script
    router.get('/client.js', (req, res) => {
      res.sendFile(path.join(__dirname, 'client.js'));
    });

    // Get available campaigns
    router.get('/campaigns', async (req, res) => {
      try {
        const campaigns = await this.fetchCampaigns();
        res.json({
          status: 'success',
          campaigns: campaigns,
          count: campaigns.length
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    });

    // Get specific campaign with promotions
    router.get('/campaigns/:id', async (req, res) => {
      try {
        const campaign = await this.getCampaign(req.params.id);
        if (!campaign) {
          return res.status(404).json({
            status: 'error',
            message: 'Campaign not found'
          });
        }

        res.json({
          status: 'success',
          campaign: campaign
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    });

    // Record event (view or click)
    router.post('/record', (req, res) => {
      try {
        const { campaignId, promotionId, type, userAddress } = req.body;

        if (!campaignId || !type) {
          return res.status(400).json({
            status: 'error',
            message: 'campaignId and type are required'
          });
        }

        if (!['view', 'click'].includes(type)) {
          return res.status(400).json({
            status: 'error',
            message: 'type must be "view" or "click"'
          });
        }

        const event = {
          campaignId,
          promotionId,
          type,
          userAddress,
          timestamp: new Date().toISOString()
        };

        const chainedEvent = this.addEventToChain(event);

        res.json({
          status: 'success',
          event: {
            hash: chainedEvent.hash,
            chainIndex: chainedEvent.chainIndex
          },
          chainLength: this.eventChain.length,
          threshold: this.threshold
        });
      } catch (error) {
        console.error('Event recording error:', error);
        res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    });

    // Get chain status
    router.get('/status', (req, res) => {
      res.json({
        status: 'success',
        chain: {
          length: this.eventChain.length,
          threshold: this.threshold,
          lastHash: this.lastHash,
          events: this.eventChain
        },
        publisher: {
          address: this.publisherAddress,
          domain: this.domain
        }
      });
    });

    // Manual flush (for testing)
    router.post('/flush', async (req, res) => {
      try {
        const results = await this.flushEvents();
        res.json({
          status: 'success',
          results: results
        });
      } catch (error) {
        res.status(500).json({
          status: 'error',
          message: error.message
        });
      }
    });

    app.use('/.well-known/epistery/agent/adnet', router);

    console.log('Adnet Agent routes attached at /.well-known/epistery/agent/adnet');

    return this;
  }

  /**
   * Periodic flush (call this in a setInterval if desired)
   */
  async periodicFlush() {
    if (this.eventChain.length > 0) {
      console.log('Periodic flush triggered');
      await this.flushEvents();
    }
  }
}
