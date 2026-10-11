#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getChainConfig } = require('../config/runtime');
const createPool = require('../db/createPool');
const createWeb3Client = require('../lib/createWeb3Client');
const TokenRepository = require('../repositories/tokenRepository');
const AveLiquidityClient = require('../lib/aveLiquidityClient');
const AveLiquidityTokenSource = require('../adapters/aveLiquidityTokenSource');
const SlidingWindowRateLimiter = require('../lib/slidingWindowRateLimiter');

const TOKEN_FIELD_FALLBACKS = [
  'token_address',
  'tokenaddress',
  'contract_address',
  'contractaddress',
  'token',
  'address'
];

function parseArgs(argv) {
  const args = {
    chain: process.env.CHAIN_NAME || 'BSC',
    file: '',
    tokenField: process.env.IMPORT_TOKEN_FIELD || 'token_address',
    source: process.env.IMPORT_SOURCE || 'dune',
    importOnly: false,
    backfillOnly: false,
    force: false,
    includeErrors: false,
    missingLiquidity: false,
    retryErrorLike: process.env.BACKFILL_RETRY_ERROR_LIKE || '',
    limit: Number(process.env.BACKFILL_LIMIT || process.env.UPDATE_LIMIT || 100),
    importLimit: Number(process.env.IMPORT_LIMIT || 0),
    batchSize: Number(process.env.BACKFILL_BATCH_SIZE || process.env.UPDATE_LIMIT || 100),
    importBatchSize: Number(process.env.IMPORT_BATCH_SIZE || 5000),
    concurrency: Number(process.env.BACKFILL_CONCURRENCY || 50),
    qps: Number(process.env.BACKFILL_QPS || 50),
    qpm: Number(process.env.BACKFILL_QPM || process.env.BACKFILL_QPS_PER_MINUTE || 3000),
    delayMs: Number(process.env.IMPORT_SCAN_DELAY_MS || 0),
    dryRun: process.env.SCAN_DRY_RUN === '1' || process.env.SCAN_DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--chain' || item === '-c') {
      args.chain = argv[++i];
    } else if (item === '--file' || item === '-f') {
      args.file = argv[++i];
    } else if (item === '--token-field') {
      args.tokenField = argv[++i];
    } else if (item === '--source') {
      args.source = argv[++i];
    } else if (item === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (item === '--import-limit') {
      args.importLimit = Number(argv[++i]);
    } else if (item === '--batch-size') {
      args.batchSize = Number(argv[++i]);
    } else if (item === '--import-batch-size') {
      args.importBatchSize = Number(argv[++i]);
    } else if (item === '--concurrency') {
      args.concurrency = Number(argv[++i]);
    } else if (item === '--qps') {
      args.qps = Number(argv[++i]);
    } else if (item === '--qpm') {
      args.qpm = Number(argv[++i]);
    } else if (item === '--delay-ms') {
      args.delayMs = Number(argv[++i]);
    } else if (item === '--import-only') {
      args.importOnly = true;
    } else if (item === '--backfill-only') {
      args.backfillOnly = true;
    } else if (item === '--force') {
      args.force = true;
    } else if (item === '--include-errors') {
      args.includeErrors = true;
    } else if (item === '--retry-error-like') {
      args.retryErrorLike = argv[++i] || '';
    } else if (item === '--missing-liquidity') {
      args.missingLiquidity = true;
    } else if (item === '--dry-run') {
      args.dryRun = true;
    }
  }

  args.limit = normalizePositiveNumber(args.limit, 100);
  args.importLimit = normalizePositiveNumber(args.importLimit, 0);
  args.batchSize = normalizePositiveNumber(args.batchSize, 100);
  args.importBatchSize = normalizePositiveNumber(args.importBatchSize, 5000);
  args.concurrency = normalizePositiveNumber(args.concurrency, 50);
  args.qps = normalizePositiveNumber(args.qps, 50);
  args.qpm = normalizePositiveNumber(args.qpm, args.qps * 60);

  return args;
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return '';
  }

  return address.toLowerCase();
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result.map(item => item.trim());
}

function findTokenFieldIndex(headers, tokenField) {
  const normalizedHeaders = headers.map(header => header.trim().toLowerCase());
  const requested = String(tokenField || '').trim().toLowerCase();
  const requestedIndex = normalizedHeaders.findIndex(header => header === requested);
  if (requestedIndex >= 0) {
    return requestedIndex;
  }

  return normalizedHeaders.findIndex(header => TOKEN_FIELD_FALLBACKS.includes(header));
}

function extractTokenFromObject(row, tokenField) {
  if (!row || typeof row !== 'object') {
    return '';
  }

  return row[tokenField]
    || row.token_address
    || row.tokenAddress
    || row.contract_address
    || row.contractAddress
    || row.token
    || row.address
    || '';
}

async function* streamTokensFromCsv(filePath, tokenField) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let tokenIndex = -1;
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }

    if (lineNumber === 1) {
      const headers = parseCsvLine(line);
      tokenIndex = findTokenFieldIndex(headers, tokenField);
      if (tokenIndex < 0) {
        throw new Error(`CSV 缺少 token 字段: ${tokenField}`);
      }
      continue;
    }

    const token = normalizeAddress(parseCsvLine(line)[tokenIndex]);
    if (token) {
      yield token;
    }
  }
}

async function* streamTokensFromJsonl(filePath, tokenField) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const token = normalizeAddress(extractTokenFromObject(JSON.parse(line), tokenField));
    if (token) {
      yield token;
    }
  }
}

async function* streamTokensFromText(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    for (const value of line.split(',')) {
      const token = normalizeAddress(value);
      if (token) {
        yield token;
      }
    }
  }
}

async function* streamTokensFromJson(filePath, tokenField) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.data || payload.rows || [];

  for (const row of rows) {
    const token = normalizeAddress(typeof row === 'string' ? row : extractTokenFromObject(row, tokenField));
    if (token) {
      yield token;
    }
  }
}

function streamTokens(filePath, tokenField) {
  const absolutePath = path.resolve(filePath);
  const ext = path.extname(absolutePath).toLowerCase();

  if (ext === '.csv') {
    return streamTokensFromCsv(absolutePath, tokenField);
  }
  if (ext === '.jsonl') {
    return streamTokensFromJsonl(absolutePath, tokenField);
  }
  if (ext === '.json') {
    return streamTokensFromJson(absolutePath, tokenField);
  }

  return streamTokensFromText(absolutePath);
}

async function importTokens(repository, chainConfig, args) {
  if (!args.file) {
    throw new Error('导入模式需要 --file');
  }

  const limit = args.importLimit > 0 ? args.importLimit : Number.POSITIVE_INFINITY;
  let parsed = 0;
  let affected = 0;
  let batch = [];

  console.log(`[${chainConfig.key}] 开始导入 file=${args.file} source=${args.source} importLimit=${Number.isFinite(limit) ? limit : 'all'} batchSize=${args.importBatchSize}`);

  for await (const token of streamTokens(args.file, args.tokenField)) {
    parsed += 1;
    batch.push(token);

    if (batch.length >= args.importBatchSize) {
      affected += await flushImportBatch(repository, chainConfig, args, batch);
      batch = [];
      logImportProgress(chainConfig, parsed, affected);
    }

    if (parsed >= limit) {
      break;
    }
  }

  if (batch.length > 0) {
    affected += await flushImportBatch(repository, chainConfig, args, batch);
  }

  console.log(`[${chainConfig.key}] 导入完成 parsed=${parsed} affected=${affected}`);
  return affected;
}

async function flushImportBatch(repository, chainConfig, args, batch) {
  const tokens = Array.from(new Set(batch));
  if (args.dryRun) {
    return tokens.length;
  }

  return repository.seedScanTokensBatch(chainConfig, tokens, args.source, {
    delayMs: args.delayMs
  });
}

function logImportProgress(chainConfig, parsed, affected) {
  if (parsed % 100000 === 0) {
    console.log(`[${chainConfig.key}] 导入进度 parsed=${parsed} affected=${affected}`);
  }
}

async function backfillTokens(repository, chainConfig, args) {
  const rateLimiter = new SlidingWindowRateLimiter({
    perSecond: args.qps,
    perMinute: args.qpm
  });
  const client = new AveLiquidityClient({
    ...(chainConfig.scan.ave || {}),
    rateLimiter
  });
  const web3 = chainConfig.scan?.calibration?.enabled ? createWeb3Client(chainConfig) : null;
  const source = new AveLiquidityTokenSource(client, repository, chainConfig, web3);
  const target = {
    ...(chainConfig.scan.targets[0] || {}),
    batchSize: args.batchSize
  };
  const limit = args.limit > 0 ? args.limit : Number.POSITIVE_INFINITY;
  let total = 0;

  const retryLabel = args.retryErrorLike ? ` retryErrorLike=${args.retryErrorLike}` : '';
  console.log(`[${chainConfig.key}] backfill 开始 limit=${Number.isFinite(limit) ? limit : 'all'} batchSize=${args.batchSize} concurrency=${args.concurrency} qps=${args.qps} qpm=${args.qpm}${retryLabel}`);

  try {
    while (total < limit) {
      const remaining = limit - total;
      const tokens = await repository.getBackfillScanTokens(chainConfig, {
        limit: Math.min(args.batchSize, remaining),
        source: args.source,
        force: args.force,
        includeErrors: args.includeErrors,
        retryErrorLike: args.retryErrorLike,
        unscannedOnly: !args.missingLiquidity
      });

      if (tokens.length === 0) {
        break;
      }

      console.log(`[${chainConfig.key}] backfill 本批 token=${tokens.length}`);
      await runWithConcurrency(tokens, args.concurrency, async row => {
        await source.scanToken(target, row.token_address, args.dryRun);
        total += 1;
      });
      console.log(`[${chainConfig.key}] backfill 进度 total=${total}`);
    }
  } finally {
    if (web3?.currentProvider?.disconnect) {
      web3.currentProvider.disconnect(1000, 'backfill complete');
    }
  }

  console.log(`[${chainConfig.key}] backfill 完成 total=${total}`);
}

async function runWithConcurrency(items, concurrency, handler) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await handler(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chainConfig = getChainConfig(args.chain);
  const pool = createPool(chainConfig.db);
  const repository = new TokenRepository(pool);

  try {
    await repository.testConnection();
    await repository.migrateAveSchema();

    if (!args.backfillOnly) {
      await importTokens(repository, chainConfig, args);
    }
    if (!args.importOnly) {
      await backfillTokens(repository, chainConfig, args);
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[backfill-tokens] 失败: ${error.message}`);
  process.exit(1);
});
