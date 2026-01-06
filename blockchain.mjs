/**
 * Blockchain service for adnet-agent
 * Handles direct contract interactions for decentralized batch submission
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BlockchainService {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.contractAbi = null;
    this.enabled = false;
    this.initialized = false;
  }

  /**
   * Initialize blockchain connection
   * @param {Object} config - Blockchain configuration
   * @param {string} config.rpcUrl - RPC endpoint URL
   * @param {string} config.privateKey - Private key for publisher wallet
   */
  async initialize(config) {
    if (this.initialized) {
      console.log('[blockchain] Already initialized');
      return;
    }

    try {
      if (!config?.rpcUrl || !config?.privateKey) {
        console.log('[blockchain] Missing rpcUrl or privateKey, running without blockchain');
        this.initialized = true;
        return;
      }

      // Connect to blockchain
      this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
      this.wallet = new ethers.Wallet(config.privateKey, this.provider);

      // Load contract ABI
      const contractPath = path.join(__dirname, 'contracts', 'CampaignWallet.json');
      if (!fs.existsSync(contractPath)) {
        console.error('[blockchain] CampaignWallet.json not found at:', contractPath);
        this.initialized = true;
        return;
      }

      const contractJson = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      this.contractAbi = contractJson.abi;

      this.enabled = true;
      this.initialized = true;

      console.log('[blockchain] Connected to:', config.rpcUrl);
      console.log('[blockchain] Publisher wallet:', this.wallet.address);
    } catch (error) {
      console.error('[blockchain] Initialization failed:', error.message);
      this.initialized = true;
      // Continue without blockchain - graceful degradation
    }
  }

  /**
   * Submit a batch to the campaign contract
   * This is the key decentralized operation - publisher submits directly to contract
   *
   * NOTE: The publisher wallet must have PUBLISHER_ROLE granted on the contract
   * before calling this function. Use contract.grantRole(PUBLISHER_ROLE, walletAddress)
   *
   * @param {string} contractAddress - Campaign contract address
   * @param {string} ipfsCID - IPFS content identifier for the batch
   * @param {number} impressions - Number of view events
   * @param {number} clicks - Number of click events
   * @param {string} lastHash - Last hash in the chain for on-chain verification
   * @returns {Promise<Object|null>} Transaction result or null if disabled
   */
  async submitBatch(contractAddress, ipfsCID, impressions, clicks, lastHash) {
    if (!this.enabled) {
      console.log('[blockchain] Not enabled, skipping contract submission');
      return null;
    }

    if (!contractAddress) {
      console.log('[blockchain] No contract address provided, skipping');
      return null;
    }

    try {
      const contract = new ethers.Contract(contractAddress, this.contractAbi, this.wallet);

      // Format lastHash as bytes32
      const hashBytes32 = this._formatBytes32(lastHash);

      console.log(`[blockchain] Submitting batch to contract ${contractAddress}`);
      console.log(`[blockchain]   IPFS CID: ${ipfsCID}`);
      console.log(`[blockchain]   Stats: ${impressions} views, ${clicks} clicks`);
      console.log(`[blockchain]   Hash: ${hashBytes32.slice(0, 18)}...`);

      const tx = await contract.submitBatch(
        ipfsCID,
        impressions,
        clicks,
        hashBytes32
      );

      console.log(`[blockchain] Transaction submitted: ${tx.hash}`);

      // Wait for confirmation
      const receipt = await tx.wait();

      console.log(`[blockchain] Transaction confirmed in block ${receipt.blockNumber}`);

      return {
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        contractAddress,
        ipfsCID,
        impressions,
        clicks,
        lastHash: hashBytes32
      };
    } catch (error) {
      console.error('[blockchain] Failed to submit batch:', error.message);
      // Log more details for debugging common issues
      if (error.message.includes('Budget exceeded')) {
        console.error('[blockchain] Campaign budget has been exhausted');
      } else if (error.message.includes('Campaign inactive')) {
        console.error('[blockchain] Campaign is paused or cancelled');
      } else if (error.message.includes('AccessControl')) {
        console.error('[blockchain] Publisher wallet does not have PUBLISHER_ROLE - contact campaign admin');
      }
      return null;
    }
  }

  /**
   * Format hash string to bytes32
   * @private
   */
  _formatBytes32(hash) {
    if (!hash) {
      return '0x' + '0'.repeat(64);
    }
    const cleanHash = hash.startsWith('0x') ? hash.slice(2) : hash;
    return '0x' + cleanHash.substring(0, 64).padEnd(64, '0');
  }

  /**
   * Check if blockchain is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Get publisher wallet address
   */
  getWalletAddress() {
    return this.wallet?.address || null;
  }
}

// Singleton instance
const blockchainService = new BlockchainService();

export default blockchainService;
