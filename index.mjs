import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { ethers } from 'ethers';
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
    const placementsFile = path.join(domainDir, 'placements.json');

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

    // Initialize placements file (publisher placement metrics)
    if (!existsSync(placementsFile)) {
      writeFileSync(placementsFile, JSON.stringify({
        placements: {},
        updated: Date.now()
      }));
    }

    return { eventsFile, batchFile, historyFile, placementsFile, domainDir };
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
   * Update placement metrics for publisher reporting
   */
  updatePlacementMetrics(domain, placement, eventType) {
    if (!placement || !placement.id) return;

    const { placementsFile } = this.getDomainFiles(domain);
    const data = JSON.parse(readFileSync(placementsFile, 'utf8'));

    const placementId = placement.id;
    const today = new Date().toISOString().split('T')[0];

    // Initialize placement if new
    if (!data.placements[placementId]) {
      data.placements[placementId] = {
        id: placementId,
        type: placement.type || 'unknown',
        pageUrl: placement.pageUrl || '',
        firstSeen: new Date().toISOString(),
        totals: { impressions: 0, clicks: 0 },
        daily: {}
      };
    }

    const p = data.placements[placementId];

    // Update page URL if provided (might change)
    if (placement.pageUrl) {
      p.pageUrl = placement.pageUrl;
    }

    // Initialize daily stats if new day
    if (!p.daily[today]) {
      p.daily[today] = { impressions: 0, clicks: 0 };
    }

    // Increment counters
    if (eventType === 'view') {
      p.totals.impressions++;
      p.daily[today].impressions++;
    } else if (eventType === 'click') {
      p.totals.clicks++;
      p.daily[today].clicks++;
    }

    p.lastSeen = new Date().toISOString();
    data.updated = Date.now();

    writeFileSync(placementsFile, JSON.stringify(data, null, 2));
  }

  /**
   * Get placement metrics for a domain
   */
  getPlacementMetrics(domain) {
    const { placementsFile } = this.getDomainFiles(domain);
    const data = JSON.parse(readFileSync(placementsFile, 'utf8'));
    return data.placements;
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
    if (state.eventChain.length === 0) return [];

    const eventsByCampaign = {};
    for (const event of state.eventChain) {
      if (!eventsByCampaign[event.campaignId]) eventsByCampaign[event.campaignId] = [];
      eventsByCampaign[event.campaignId].push(event);
    }

    const results = [];
    for (const [campaignId, events] of Object.entries(eventsByCampaign)) {
      const views = events.filter(e => e.type === 'view').length;
      const clicks = events.filter(e => e.type === 'click').length;

      // REACH LOGIC:
      // Count unique VERIFIED wallet addresses with minimum notabot score.
      // This provides proof of: 1) Real wallet (signature), 2) Likely human (notabot)
      const MIN_NOTABOT_SCORE = 10; // Minimum points to count as verified human
      const verifiedViewers = new Set();
      let unverifiedViews = 0;
      let lowNotabotViews = 0;

      events.filter(e => e.type === 'view').forEach(e => {
        if (e.verified && e.userAddress) {
          if (e.notabotScore >= MIN_NOTABOT_SCORE) {
            verifiedViewers.add(e.userAddress);
          } else {
            lowNotabotViews++;
          }
        } else {
          unverifiedViews++;
        }
      });

      const reach = verifiedViewers.size;
      if (unverifiedViews > 0 || lowNotabotViews > 0) {
        console.log(`[adnet] Reach: ${reach} verified humans. Excluded: ${unverifiedViews} unverified, ${lowNotabotViews} low notabot score`);
      }

      const dataWallet = {
        type: 'adnet-event-batch',
        campaignId,
        summary: { views, clicks, reach },
        publisher: { domain, address: this.epistery?.domain?.wallet?.address || null },
        events: events,
        lastHash: state.lastHash
      };

      try {
        const ipfsResult = await this.uploadToIPFS(dataWallet);
        if (ipfsResult) {
          const campaign = this.campaignsCache.find(c => c.id === campaignId);
          if (campaign?.contractAddress && blockchainService.isEnabled()) {
            // Push to individual CampaignWallet with on-chain hash verification
            await blockchainService.submitBatch(
              campaign.contractAddress,
              ipfsResult.hash,
              views,
              clicks,
              state.lastHash
            );
          }

          // Record flush to history
          this.recordFlushHistory(domain, {
            campaignId,
            events,
            ipfsHash: ipfsResult.hash,
            success: true
          });
        }
        results.push({ campaignId, success: !!ipfsResult });
      } catch (e) {
        console.error(`[adnet] Flush error:`, e);
      }
    }

    state.eventChain = [];
    state.lastHash = crypto.createHash('sha256').update(Date.now().toString()).digest('hex');
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
   * Verify same-domain authentication (user's wallet address from header)
   * Similar to message-board's authentication pattern
   */
  async verifySameDomainAuth(req) {
    try {
      const address = req.headers['x-wallet-address'];

      if (!address) {
        return { valid: false, error: 'No wallet address provided' };
      }

      const domain = req.publisherDomain;

      // Verify this address is on publisher whitelist
      if (this.epistery) {
        // Check global admin first
        const isGlobalAdmin = await this.isListedCaseInsensitive(address, 'epistery::admin');
        if (isGlobalAdmin) {
          return { valid: true, address, isGlobalAdmin: true, domain };
        }

        // Check domain admin
        const isDomainAdmin = await this.isListedCaseInsensitive(address, `${domain}::admin`);
        if (isDomainAdmin) {
          return { valid: true, address, isDomainAdmin: true, domain };
        }

        // Check adnet publishers list
        const isPublisher = await this.isListedCaseInsensitive(address, 'adnet::publishers');
        if (isPublisher) {
          return { valid: true, address, isPublisher: true, domain };
        }
      } else {
        // Development mode - allow all authenticated users
        console.log('[adnet] No epistery instance, allowing all authenticated users');
        return { valid: true, address, domain };
      }

      return { valid: false, error: 'Not authorized - wallet not on publisher whitelist' };
    } catch (error) {
      console.error('[adnet] Same-domain auth error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Case-insensitive whitelist check
   * Ethereum addresses are case-insensitive but string comparison is not
   */
  async isListedCaseInsensitive(address, listName) {
    try {
      const list = await this.epistery.getList(listName);
      const addressLower = address.toLowerCase();
      return list.some(entry => entry.addr.toLowerCase() === addressLower);
    } catch (error) {
      console.error(`[adnet] Error checking list ${listName}:`, error);
      return false;
    }
  }

  /**
   * Verify signed event from client
   * Proves the user owns the wallet they claim
   */
  verifyEventSignature(userAddress, signature, campaignId, type, timestamp) {
    if (!userAddress || !signature) {
      return { verified: false, address: null };
    }

    try {
      const message = `adnet:${campaignId}:${type}:${timestamp}`;
      const recoveredAddress = ethers.verifyMessage(message, signature);
      const verified = recoveredAddress.toLowerCase() === userAddress.toLowerCase();

      if (verified) {
        return { verified: true, address: recoveredAddress.toLowerCase() };
      } else {
        console.warn(`[adnet] Signature mismatch: claimed ${userAddress}, recovered ${recoveredAddress}`);
        return { verified: false, address: null };
      }
    } catch (error) {
      console.error('[adnet] Signature verification failed:', error.message);
      return { verified: false, address: null };
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
      req.publisherDomain = req.hostname || req.get('host')?.split(':')[0] || 'localhost';

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

    // Auth check endpoint - verifies if user is on publisher whitelist
    router.get('/api/auth/check', async (req, res) => {
      const auth = await this.verifySameDomainAuth(req);

      if (auth.valid) {
        res.json({
          authenticated: true,
          address: auth.address,
          isGlobalAdmin: auth.isGlobalAdmin || false,
          isDomainAdmin: auth.isDomainAdmin || false,
          isPublisher: auth.isPublisher || false,
          domain: auth.domain
        });
      } else {
        res.json({
          authenticated: false,
          error: auth.error
        });
      }
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

    // Get campaign report - merges blockchain state with local metrics
    router.get('/campaigns/:campaignId/report', async (req, res) => {
      const { campaignId } = req.params;
      const domain = req.publisherDomain;
      console.log(`[adnet] Fetching report for campaign ${campaignId} on ${domain}`);

      try {
        // 1. Get blockchain state from factory (budget, spent, active)
        let blockchainState = null;
        try {
          const response = await fetch(`${this.factoryUrl}/api/campaign/${campaignId}/report`);
          if (response.ok) {
            const data = await response.json();
            blockchainState = data.report || null;
          }
        } catch (err) {
          console.warn(`[adnet] Failed to fetch blockchain state:`, err.message);
        }

        // 2. Aggregate local history for this campaign
        const { historyFile } = this.getDomainFiles(domain);
        const history = JSON.parse(readFileSync(historyFile, 'utf8'));

        // Sum up views/clicks for this specific campaign
        let localViews = 0;
        let localClicks = 0;
        let batchCount = 0;
        const batches = [];

        for (const flush of (history.flushes || [])) {
          if (flush.campaignId === campaignId) {
            localViews += flush.views || 0;
            localClicks += flush.clicks || 0;
            batchCount++;
            batches.push({
              timestamp: flush.timestamp,
              views: flush.views || 0,
              clicks: flush.clicks || 0,
              ipfsHash: flush.ipfsHash,
              txHash: flush.txHash || null,
              success: flush.success
            });
          }
        }

        // 3. Merge and return
        res.json({
          status: 'success',
          campaignId,
          report: {
            // Local metrics (from flush history)
            impressions: localViews.toString(),
            clicks: localClicks.toString(),
            batchCount,
            batches,
            // Blockchain state (from factory)
            budget: blockchainState?.budget || '0',
            spent: blockchainState?.spent || '0',
            remaining: blockchainState?.remaining || '0',
            active: blockchainState?.active ?? true
          }
        });
      } catch (error) {
        console.error(`[adnet] Failed to build report for ${campaignId}:`, error.message);
        res.status(500).json({ error: 'Failed to build campaign report' });
      }
    });

    // Record event (view or click)
    router.post('/record', async (req, res) => {
      try {
        const { campaignId, promotionId, type, timestamp, userAddress, signature, notabotScore, placement } = req.body;
        const domain = req.publisherDomain; // Set by your middleware

        // 1. Validation
        if (!campaignId || !type) {
          return res.status(400).json({ status: 'error', message: 'campaignId and type required' });
        }

        if (!['view', 'click'].includes(type)) {
          return res.status(400).json({ status: 'error', message: 'Invalid event type' });
        }

        // 2. Verify signature (cryptographic proof of wallet ownership)
        const verification = this.verifyEventSignature(userAddress, signature, campaignId, type, timestamp);

        // 3. Construct the Event Object
        const event = {
          campaignId,
          promotionId: promotionId || 'default',
          type,
          userAddress: verification.verified ? verification.address : null,
          verified: verification.verified,
          notabotScore: notabotScore?.points || 0,
          timestamp: new Date().toISOString(),
          metadata: {
            userAgent: req.get('User-Agent'),
            referrer: req.get('Referrer'),
            placement: placement || null
          }
        };

        // 4. Add to the Domain's Cryptographic Chain
        // This function hashes the event and links it to the previousHash
        const chainedEvent = this.addEventToChain(domain, event);
        const state = this.getDomainState(domain);

        // 5. Update placement metrics for publisher reporting
        if (placement) {
          this.updatePlacementMetrics(domain, placement, type);
        }

        res.json({
          status: 'success',
          eventHash: chainedEvent.hash,
          verified: verification.verified,
          notabotScore: event.notabotScore,
          batchProgress: `${state.eventChain.length}/${this.threshold}`
        });
      } catch (error) {
        console.error('[adnet] Record error:', error);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
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

    // Get all placements with metrics (for publisher dashboard)
    router.get('/placements', (req, res) => {
      const domain = req.publisherDomain;
      const placements = this.getPlacementMetrics(domain);

      // Convert to array and calculate CTR
      const placementList = Object.values(placements).map(p => ({
        ...p,
        ctr: p.totals.impressions > 0
          ? ((p.totals.clicks / p.totals.impressions) * 100).toFixed(2)
          : '0.00'
      }));

      // Sort by impressions descending
      placementList.sort((a, b) => b.totals.impressions - a.totals.impressions);

      res.json({
        status: 'success',
        domain,
        placements: placementList,
        count: placementList.length
      });
    });

    // Get detailed report for a specific placement
    router.get('/placements/:placementId/report', (req, res) => {
      const domain = req.publisherDomain;
      const { placementId } = req.params;
      const { days = 7 } = req.query;

      const placements = this.getPlacementMetrics(domain);
      const placement = placements[placementId];

      if (!placement) {
        return res.status(404).json({
          status: 'error',
          message: 'Placement not found'
        });
      }

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      // Build daily metrics for the date range
      const dailyMetrics = [];
      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const dayData = placement.daily[dateStr] || { impressions: 0, clicks: 0 };
        dailyMetrics.push({
          date: dateStr,
          impressions: dayData.impressions,
          clicks: dayData.clicks,
          ctr: dayData.impressions > 0
            ? ((dayData.clicks / dayData.impressions) * 100).toFixed(2)
            : '0.00'
        });
      }

      res.json({
        status: 'success',
        placement: {
          id: placement.id,
          type: placement.type,
          pageUrl: placement.pageUrl,
          firstSeen: placement.firstSeen,
          lastSeen: placement.lastSeen,
          totals: {
            ...placement.totals,
            ctr: placement.totals.impressions > 0
              ? ((placement.totals.clicks / placement.totals.impressions) * 100).toFixed(2)
              : '0.00'
          },
          daily: dailyMetrics
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
