import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { Config } from 'epistery';
import blockchainService from './blockchain.mjs';

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
 *
 * Domain-specific storage pattern (same as message-board):
 * - Each publisher domain gets its own event chain
 * - Events persist to disk and survive restarts
 * - Batches flush to IPFS as Data Wallets
 */
export default class AdnetAgent {
  constructor(config = {}) {
    this.config = config;
    this.epistery = null;

    // Configuration
    this.threshold = config.threshold || 5;
    this.factoryUrl = config.factoryUrl || 'https://adnet.geistm.com';

    // IPFS configuration (same as message-board)
    this.ipfsUrl = config.ipfsUrl || 'https://rootz.digital/api/v0';
    this.ipfsGateway = config.ipfsGateway || 'https://rootz.digital';

    // Cache of available campaigns
    this.campaignsCache = [];
    this.cacheExpiry = 0;
    this.cacheDuration = 5 * 60 * 1000; // 5 minutes

    // Data storage - domain-specific paths set per-request
    this.dataDir = path.join(__dirname, 'data');

    // Per-domain state (keyed by domain)
    this.domainStates = new Map();

    // Blockchain initialization flag
    this.blockchainInitialized = false;

    console.log('[adnet] Agent initialized');
    console.log('[adnet] Threshold:', this.threshold);
    console.log('[adnet] IPFS URL:', this.ipfsUrl);
    console.log('[adnet] Factory URL:', this.factoryUrl);
  }

  /**
   * Initialize blockchain service from Epistery config
   * Uses the publisher domain's wallet and provider from ~/.epistery/[domain]/config.ini
   */
  async initializeBlockchain(domain) {
    if (this.blockchainInitialized) return;

    try {
      let blockchainConfig = null;

      // Load config for the publisher's domain
      if (domain) {
        const domainConfig = new Config();
        domainConfig.setPath(domain);
        try {
          domainConfig.load();

          // Check for explicit blockchain section first
          if (domainConfig.data?.blockchain?.rpcUrl && domainConfig.data?.blockchain?.privateKey) {
            blockchainConfig = {
              rpcUrl: domainConfig.data.blockchain.rpcUrl,
              privateKey: domainConfig.data.blockchain.privateKey
            };
            console.log(`[adnet] Found blockchain config in ${domain}`);
          }
          // Fall back to domain's wallet and provider
          else if (domainConfig.data?.provider?.rpc && domainConfig.data?.wallet?.privateKey) {
            blockchainConfig = {
              rpcUrl: domainConfig.data.provider.rpc,
              privateKey: domainConfig.data.wallet.privateKey
            };
            console.log(`[adnet] Using ${domain} wallet for blockchain`);
          }
        } catch (e) {
          console.log(`[adnet] No config for domain ${domain}`);
        }
      }

      // Fall back to root config's default provider
      if (!blockchainConfig) {
        const rootConfig = new Config();
        rootConfig.setPath('/');
        try {
          rootConfig.load();
          const rpcUrl = rootConfig.data?.default?.provider?.rpc;
          // Note: root config typically doesn't have a privateKey, need domain wallet
          if (rpcUrl) {
            console.log('[adnet] Found RPC in root config but no wallet - need domain config');
          }
        } catch (e) {
          // Root config doesn't exist
        }
      }

      if (blockchainConfig?.rpcUrl && blockchainConfig?.privateKey) {
        await blockchainService.initialize(blockchainConfig);
      } else {
        console.log('[adnet] No blockchain config found, running without contract submission');
      }

      this.blockchainInitialized = true;
    } catch (error) {
      console.error('[adnet] Failed to load blockchain config:', error.message);
      this.blockchainInitialized = true; // Don't retry
    }
  }

  /**
   * Get domain-specific file paths and initialize if needed
   */
  getDomainFiles(domain) {
    const domainDir = path.join(this.dataDir, domain);
    const eventsFile = path.join(domainDir, 'events.json');
    const batchFile = path.join(domainDir, 'batch.json');
    const historyFile = path.join(domainDir, 'history.json');

    // Ensure domain directory exists
    if (!existsSync(domainDir)) {
      mkdirSync(domainDir, { recursive: true });
      console.log(`[adnet] Created data directory for domain: ${domain}`);
    }

    // Initialize events file (current pending events)
    if (!existsSync(eventsFile)) {
      writeFileSync(eventsFile, JSON.stringify({
        events: [],
        lastHash: '0000000000000000000000000000000000000000000000000000000000000000',
        updated: Date.now()
      }));
    }

    // Initialize batch file (chain state)
    if (!existsSync(batchFile)) {
      writeFileSync(batchFile, JSON.stringify({
        chain: [],
        lastHash: '0000000000000000000000000000000000000000000000000000000000000000',
        lastFlush: null,
        flushCount: 0
      }));
    }

    // Initialize history file (record of all flushes)
    if (!existsSync(historyFile)) {
      writeFileSync(historyFile, JSON.stringify({
        flushes: [],
        totalEvents: 0,
        totalViews: 0,
        totalClicks: 0
      }));
    }

    return { eventsFile, batchFile, historyFile, domainDir };
  }

  /**
   * Get or initialize domain state
   */
  getDomainState(domain) {
    if (!this.domainStates.has(domain)) {
      const { eventsFile, batchFile } = this.getDomainFiles(domain);
      const eventsData = JSON.parse(readFileSync(eventsFile, 'utf8'));
      const batchData = JSON.parse(readFileSync(batchFile, 'utf8'));

      this.domainStates.set(domain, {
        eventChain: eventsData.events || [],
        lastHash: eventsData.lastHash || '0000000000000000000000000000000000000000000000000000000000000000',
        flushCount: batchData.flushCount || 0
      });

      console.log(`[adnet] Loaded state for ${domain}: ${eventsData.events?.length || 0} pending events`);
    }
    return this.domainStates.get(domain);
  }

  /**
   * Save domain state to file
   */
  saveDomainState(domain) {
    const state = this.domainStates.get(domain);
    if (!state) return;

    const { eventsFile, batchFile } = this.getDomainFiles(domain);

    // Save current events
    writeFileSync(eventsFile, JSON.stringify({
      events: state.eventChain,
      lastHash: state.lastHash,
      updated: Date.now()
    }, null, 2));

    // Save batch state
    writeFileSync(batchFile, JSON.stringify({
      chain: state.eventChain,
      lastHash: state.lastHash,
      lastFlush: Date.now(),
      flushCount: state.flushCount
    }, null, 2));
  }

  /**
   * Record flush to history
   */
  recordFlushHistory(domain, flushResult) {
    const { historyFile } = this.getDomainFiles(domain);
    const history = JSON.parse(readFileSync(historyFile, 'utf8'));

    const views = flushResult.events?.filter(e => e.type === 'view').length || 0;
    const clicks = flushResult.events?.filter(e => e.type === 'click').length || 0;

    history.flushes.push({
      timestamp: new Date().toISOString(),
      campaignId: flushResult.campaignId,
      eventCount: flushResult.events?.length || 0,
      views,
      clicks,
      ipfsHash: flushResult.ipfsHash,
      ipfsUrl: flushResult.ipfsUrl,
      success: flushResult.success
    });

    history.totalEvents += flushResult.events?.length || 0;
    history.totalViews += views;
    history.totalClicks += clicks;

    writeFileSync(historyFile, JSON.stringify(history, null, 2));
  }

  /**
   * Create a hash of event data
   */
  hashEvent(event, previousHash) {
    const data = JSON.stringify({
      ...event,
      previousHash
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Add event to the domain's chain
   */
  addEventToChain(domain, event) {
    const state = this.getDomainState(domain);

    const hash = this.hashEvent(event, state.lastHash);
    const chainedEvent = {
      ...event,
      hash,
      previousHash: state.lastHash,
      chainIndex: state.eventChain.length
    };

    state.eventChain.push(chainedEvent);
    state.lastHash = hash;

    // Persist to disk
    this.saveDomainState(domain);

    console.log(`[adnet] ${domain}: Event added. Chain: ${state.eventChain.length}/${this.threshold}`);

    // Check if we've reached threshold
    if (state.eventChain.length >= this.threshold) {
      this.flushEvents(domain);
    }

    return chainedEvent;
  }

  /**
   * Upload data to IPFS (same pattern as message-board)
   */
  async uploadToIPFS(data) {
    if (!this.ipfsUrl) {
      console.warn('[adnet] IPFS URL not configured');
      return null;
    }

    try {
      const formData = new FormData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      formData.append('file', blob, 'events.json');

      const response = await fetch(`${this.ipfsUrl}/add`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        console.error(`[adnet] IPFS upload failed: ${response.status}`);
        return null;
      }

      const result = await response.json();
      return {
        hash: result.Hash,
        url: `${this.ipfsGateway}/ipfs/${result.Hash}`
      };
    } catch (error) {
      console.error('[adnet] IPFS upload error:', error);
      return null;
    }
  }

  /**
   * Flush batched events to IPFS as Data Wallet
   */
  async flushEvents(domain) {
    const state = this.getDomainState(domain);

    if (state.eventChain.length === 0) {
      console.log(`[adnet] ${domain}: No events to flush`);
      return [];
    }

    console.log(`[adnet] ${domain}: Flushing ${state.eventChain.length} events to IPFS`);

    // Group events by campaign
    const eventsByCampaign = {};
    for (const event of state.eventChain) {
      if (!eventsByCampaign[event.campaignId]) {
        eventsByCampaign[event.campaignId] = [];
      }
      eventsByCampaign[event.campaignId].push(event);
    }

    const results = [];

    for (const [campaignId, events] of Object.entries(eventsByCampaign)) {
      const views = events.filter(e => e.type === 'view').length;
      const clicks = events.filter(e => e.type === 'click').length;

      // Create Data Wallet structure (same pattern as message-board)
      const dataWallet = {
        type: 'adnet-event-batch',
        version: '1.0.0',
        campaignId,
        events: events.map(e => ({
          type: e.type,
          promotionId: e.promotionId,
          userAddress: e.userAddress,
          userVerified: e.userVerified,
          timestamp: e.timestamp,
          hash: e.hash,
          previousHash: e.previousHash,
          chainIndex: e.chainIndex
        })),
        summary: {
          views,
          clicks,
          total: events.length
        },
        chain: {
          lastHash: state.lastHash,
          length: events.length
        },
        publisher: {
          domain: domain,
          address: this.epistery?.domain?.wallet?.address || null
        },
        factory: this.factoryUrl,
        timestamp: new Date().toISOString()
      };

      // Upload to IPFS
      try {
        const ipfsResult = await this.uploadToIPFS(dataWallet);
        const flushResult = {
          campaignId,
          events,
          success: !!ipfsResult,
          ipfsHash: ipfsResult?.hash,
          ipfsUrl: ipfsResult?.url,
          error: ipfsResult ? null : 'IPFS unavailable'
        };

        if (ipfsResult) {
          console.log(`[adnet] ${domain}: Campaign ${campaignId}: ${events.length} events (${views} views, ${clicks} clicks)`);
          console.log(`[adnet] ${domain}:   IPFS: ${ipfsResult.url}`);

          // Submit batch directly to campaign contract (decentralized)
          const campaign = this.campaignsCache.find(c => c.id === campaignId || c.campaignId === campaignId);
          const contractAddress = campaign?.contractAddress;

          if (contractAddress && blockchainService.isEnabled()) {
            const txResult = await blockchainService.submitBatch(
              contractAddress,
              ipfsResult.hash,
              views,
              clicks,
              events.length, // reach
              state.lastHash
            );

            if (txResult) {
              console.log(`[adnet] ${domain}:   Contract: tx ${txResult.txHash}`);
              flushResult.txHash = txResult.txHash;
              flushResult.blockNumber = txResult.blockNumber;
            } else {
              console.log(`[adnet] ${domain}:   Contract submission skipped or failed`);
            }
          } else if (!contractAddress) {
            console.log(`[adnet] ${domain}:   No contract address for campaign ${campaignId}`);
          }
        } else {
          console.log(`[adnet] ${domain}: Campaign ${campaignId}: ${events.length} events (IPFS unavailable)`);
        }

        // Record to history
        this.recordFlushHistory(domain, flushResult);
        results.push(flushResult);
      } catch (error) {
        console.error(`[adnet] ${domain}: Failed to upload campaign ${campaignId}:`, error.message);
        results.push({ campaignId, success: false, error: error.message });
      }
    }

    // Clear the chain and update state
    state.eventChain = [];
    state.lastHash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
    state.flushCount++;
    this.saveDomainState(domain);

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
    // Get epistery instance from app.locals and set domain per-request
    router.use(async (req, res, next) => {
      // Store domain in request for domain-specific data access
      req.publisherDomain = req.hostname || 'localhost';

      if (!this.epistery && req.app.locals.epistery) {
        this.epistery = req.app.locals.epistery;
        console.log('[adnet] Epistery instance attached');
      }

      // Initialize blockchain service with domain config (only once)
      if (!this.blockchainInitialized) {
        await this.initializeBlockchain(req.publisherDomain);
      }

      next();
    });

    // Redirect root to status
    router.get('/', (req, res) => {
      res.redirect(req.baseUrl + '/status');
    });

    // Static files
    router.use(express.static(path.join(__dirname, 'public')));

    // Client script
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

    // Serve widget (for agent box)
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

    // Record event (view or click)
    router.post('/record', async (req, res) => {
      try {
        const { campaignId, promotionId, type } = req.body;
        const domain = req.publisherDomain;

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

        const chainedEvent = this.addEventToChain(domain, event);
        const state = this.getDomainState(domain);

        res.json({
          status: 'success',
          event: { hash: chainedEvent.hash, chainIndex: chainedEvent.chainIndex },
          chainLength: state.eventChain.length,
          threshold: this.threshold
        });
      } catch (error) {
        console.error('[adnet] Record error:', error);
        res.status(500).json({ status: 'error', message: error.message });
      }
    });

    // Status (domain-specific)
    router.get('/status', (req, res) => {
      const domain = req.publisherDomain;
      const state = this.getDomainState(domain);
      const { historyFile } = this.getDomainFiles(domain);
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));

      res.json({
        status: 'success',
        domain,
        chain: {
          length: state.eventChain.length,
          threshold: this.threshold,
          lastHash: state.lastHash
        },
        stats: {
          flushCount: state.flushCount,
          totalEvents: history.totalEvents,
          totalViews: history.totalViews,
          totalClicks: history.totalClicks
        },
        factory: { url: this.factoryUrl },
        ipfs: { url: this.ipfsUrl, gateway: this.ipfsGateway },
        blockchain: {
          enabled: blockchainService.isEnabled(),
          wallet: blockchainService.getWalletAddress()
        }
      });
    });

    // Debug endpoint to see epistery config
    router.get('/debug/config', (req, res) => {
      const ep = this.epistery;
      res.json({
        hasEpistery: !!ep,
        episteryKeys: ep ? Object.keys(ep) : [],
        domain: ep?.domain,
        config: ep?.config,
        configData: ep?.config?.data,
        wallet: ep?.wallet || ep?.domain?.wallet
      });
    });

    // History (domain-specific)
    router.get('/history', (req, res) => {
      const domain = req.publisherDomain;
      const { historyFile } = this.getDomainFiles(domain);
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));

      res.json({
        status: 'success',
        domain,
        ...history
      });
    });

    // Manual flush (domain-specific)
    router.post('/flush', async (req, res) => {
      const domain = req.publisherDomain;
      const results = await this.flushEvents(domain);
      res.json({ status: 'success', domain, results });
    });

    // Health check
    router.get('/health', (req, res) => {
      const domain = req.publisherDomain;
      const state = this.getDomainState(domain);

      res.json({
        status: 'healthy',
        domain,
        pendingEvents: state.eventChain.length,
        threshold: this.threshold,
        factoryUrl: this.factoryUrl,
        ipfsUrl: this.ipfsUrl
      });
    });

    // API health (for widget/admin)
    router.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        agent: 'adnet-agent',
        version: '1.0.0',
        config: {
          threshold: this.threshold,
          factoryUrl: this.factoryUrl,
          ipfsUrl: this.ipfsUrl
        }
      });
    });

    console.log('[adnet] Agent routes attached');
    return this;
  }

  /**
   * Cleanup on shutdown - flush all pending events
   */
  async cleanup() {
    console.log('[adnet] Cleanup: Flushing pending events for all domains...');

    for (const [domain, state] of this.domainStates) {
      if (state.eventChain.length > 0) {
        console.log(`[adnet] Flushing ${state.eventChain.length} events for ${domain}`);
        try {
          await this.flushEvents(domain);
        } catch (error) {
          console.error(`[adnet] Failed to flush events for ${domain}:`, error);
          // Events are persisted to disk, so they won't be lost
        }
      }
    }

    console.log('[adnet] Cleanup complete');
  }
}
