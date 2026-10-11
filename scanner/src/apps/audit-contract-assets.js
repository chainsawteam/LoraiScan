#!/usr/bin/env node

const { getChainConfig } = require('../config/runtime');
const createPool = require('../db/createPool');
const LoraiAuditClient = require('../lib/loraiAuditClient');
const TokenRepository = require('../repositories/tokenRepository');

function parseArgs(argv) {
  const args = {
    chain: process.env.CHAIN_NAME || 'BSC',
    source: process.env.AUDIT_CONTRACT_SOURCE || 'dune',
    dataset: process.env.AUDIT_CONTRACT_DATASET || '',
    limit: Number(process.env.AUDIT_CONTRACT_LIMIT || 100),
    sleepMs: Number(process.env.AUDIT_CONTRACT_SLEEP_MS || 0),
    priorityBase: Number(process.env.AUDIT_CONTRACT_PRIORITY_BASE || process.env.LORAI_AUDIT_PRIORITY || 100),
    onlyNonToken: process.env.AUDIT_CONTRACT_INCLUDE_TOKENS !== '1' && process.env.AUDIT_CONTRACT_INCLUDE_TOKENS !== 'true',
    includeSubmitted: process.env.AUDIT_CONTRACT_INCLUDE_SUBMITTED === '1' || process.env.AUDIT_CONTRACT_INCLUDE_SUBMITTED === 'true',
    dryRun: process.env.SCAN_DRY_RUN === '1' || process.env.SCAN_DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--chain' || item === '-c') {
      args.chain = argv[++i];
    } else if (item === '--source') {
      args.source = argv[++i];
    } else if (item === '--dataset') {
      args.dataset = argv[++i];
    } else if (item === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (item === '--sleep-ms') {
      args.sleepMs = Number(argv[++i]);
    } else if (item === '--priority-base') {
      args.priorityBase = Number(argv[++i]);
    } else if (item === '--include-tokens') {
      args.onlyNonToken = false;
    } else if (item === '--include-submitted') {
      args.includeSubmitted = true;
    } else if (item === '--dry-run') {
      args.dryRun = true;
    }
  }

  args.limit = normalizePositiveNumber(args.limit, 100);
  args.sleepMs = normalizePositiveNumber(args.sleepMs, 0);
  args.priorityBase = normalizePositiveNumber(args.priorityBase, 100);

  return args;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function auditContractAssets(repository, chainConfig, args) {
  const auditClient = new LoraiAuditClient({
    ...(chainConfig.scan?.audit || {}),
    enabled: true
  }, chainConfig);
  const contracts = await repository.getContractAssetsForAudit(chainConfig, {
    limit: args.limit,
    source: args.source,
    dataset: args.dataset,
    onlyNonToken: args.onlyNonToken,
    includeSubmitted: args.includeSubmitted
  });

  console.log(`[${chainConfig.key}] contract_assets LoraAI 扫描开始 limit=${args.limit} selected=${contracts.length} source=${args.source || 'all'} dataset=${args.dataset || 'all'} onlyNonToken=${args.onlyNonToken} dryRun=${args.dryRun}`);

  let submitted = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < contracts.length; i++) {
    const item = contracts[i];
    const priority = args.priorityBase + i;
    const prefix = `[${chainConfig.key}] [${i + 1}/${contracts.length}] contract=${item.contract_address} score=${item.score || 'null'} priority=${priority}`;

    if (args.dryRun) {
      console.log(`${prefix} dry-run`);
      continue;
    }

    try {
      const result = await auditClient.ensureAudit(chainConfig, item.contract_address, { priority });
      const auditAction = result.skipped ? `skipped_${result.reason}` : 'submitted';
      await repository.updateContractAssetAudit(item.id, {
        auditAction,
        auditRunId: result.runId || null,
        auditError: null
      });

      if (result.skipped) {
        skipped += 1;
      } else {
        submitted += 1;
      }
      console.log(`${prefix} ${auditAction}${result.runId ? ` runId=${result.runId}` : ''}`);
    } catch (error) {
      failed += 1;
      await repository.updateContractAssetAudit(item.id, {
        auditAction: 'failed',
        auditRunId: null,
        auditError: error.message || String(error)
      });
      console.error(`${prefix} failed error=${error.message || error}`);
    }

    if (args.sleepMs > 0 && i < contracts.length - 1) {
      await sleep(args.sleepMs);
    }
  }

  console.log(`[${chainConfig.key}] contract_assets LoraAI 扫描完成 selected=${contracts.length} submitted=${submitted} skipped=${skipped} failed=${failed}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chainConfig = getChainConfig(args.chain);
  const pool = createPool(chainConfig.db);
  const repository = new TokenRepository(pool);

  try {
    await repository.testConnection();
    await repository.migrateAveSchema();
    await auditContractAssets(repository, chainConfig, args);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[audit-contract-assets] 失败: ${error.message}`);
  process.exit(1);
});
