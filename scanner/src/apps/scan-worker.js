#!/usr/bin/env node

const { getChainConfig } = require('../config/runtime');
const createPool = require('../db/createPool');
const createWeb3Client = require('../lib/createWeb3Client');
const TokenRepository = require('../repositories/tokenRepository');
const TokenScannerService = require('../services/tokenScannerService');

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return value === '1' || value.toLowerCase() === 'true';
}

function createDryRunListenRepository() {
  const scannerState = new Map();
  const observedPools = new Map();

  return {
    dryRunMemoryState: true,
    async testConnection() {},
    async getScannerState(_chainConfig, sourceKey) {
      return scannerState.get(sourceKey) || null;
    },
    async upsertScannerState(_chainConfig, sourceKey, lastBlock, metadata = {}) {
      scannerState.set(sourceKey, {
        source_key: sourceKey,
        last_block: lastBlock,
        metadata
      });
    },
    async upsertObservedPools(chainConfig, pools) {
      let inserted = 0;
      for (const pool of pools || []) {
        const poolAddress = String(pool.poolAddress || '').toLowerCase();
        if (!poolAddress || observedPools.has(poolAddress)) {
          continue;
        }

        observedPools.set(poolAddress, {
          chain_name: chainConfig.key,
          chain_id: chainConfig.chainId,
          source_key: pool.sourceKey,
          protocol: pool.protocol,
          factory_address: String(pool.factoryAddress || '').toLowerCase(),
          pool_address: poolAddress,
          token0_address: String(pool.token0 || '').toLowerCase(),
          token1_address: String(pool.token1 || '').toLowerCase(),
          created_block: pool.createdBlock || null
        });
        inserted += 1;
      }

      return inserted;
    },
    async getObservedPoolsByAddresses(_chainConfig, poolAddresses) {
      const result = new Map();
      for (const address of poolAddresses || []) {
        const normalized = String(address || '').toLowerCase();
        const pool = observedPools.get(normalized);
        if (pool) {
          result.set(normalized, pool);
        }
      }

      return result;
    },
    async markObservedPoolLiquidity() {},
    async seedScanTokens() {
      return 0;
    },
    async isKnownTokenAsset() {
      return false;
    },
    async getTokenProxyState() {
      return null;
    },
    async upsertTokenProxyState() {},
    async insertTokenProxyEvent() {
      return { id: 0, inserted: false };
    },
    async updateTokenProxyEventAudit() {
      return 0;
    }
  };
}

function parseChainName() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chain' || args[i] === '-c') {
      return args[i + 1];
    }
  }

  return process.env.CHAIN_NAME || 'BSC';
}

async function main() {
  const chainName = parseChainName();
  const chainConfig = getChainConfig(chainName);
  const dryRun = envFlag('SCAN_DRY_RUN');
  const listenOnly = envFlag('SCAN_LISTEN_ONLY') || envFlag('SCAN_DISCOVERY_ONLY');
  const observeAve = envFlag('SCAN_OBSERVE_AVE');
  if (listenOnly && !dryRun) {
    throw new Error('SCAN_LISTEN_ONLY 只能与 SCAN_DRY_RUN=1 一起使用');
  }
  if (observeAve && !dryRun) {
    throw new Error('SCAN_OBSERVE_AVE 只能与 SCAN_DRY_RUN=1 一起使用');
  }

  const pool = listenOnly ? null : createPool(chainConfig.db);
  const discoveryConfigs = chainConfig.scan.discoveries || [chainConfig.scan.discovery];
  const discoveryEnabled = discoveryConfigs.some(config => config?.enabled);
  const calibrationEnabled = Boolean(chainConfig.scan?.calibration?.enabled);
  const proxyUpgradeEnabled = Boolean(chainConfig.scan?.proxyUpgrade?.enabled);
  const methodCallEnabled = Boolean(chainConfig.scan?.methodCallMonitor?.enabled);
  const contractValueMonitorEnabled = Boolean(chainConfig.scan?.contractValueMonitor?.enabled);
  const flapVaultFactoryEnabled = Boolean(chainConfig.scan?.flapVaultFactory?.enabled);
  const web3 = chainConfig.scan.sourceType === 'ave_liquidity_v1' && !discoveryEnabled && !calibrationEnabled && !proxyUpgradeEnabled && !methodCallEnabled && !contractValueMonitorEnabled && !flapVaultFactoryEnabled
    ? null
    : createWeb3Client(chainConfig);
  const repository = listenOnly ? createDryRunListenRepository() : new TokenRepository(pool);
  const service = new TokenScannerService({
    chainConfig,
    web3,
    repository,
    dryRun,
    listenOnly,
    observeAve
  });

  await service.start();
}

main().catch(error => {
  console.error(`[scan-worker] 启动失败: ${error.message}`);
  process.exit(1);
});
