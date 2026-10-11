#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getChainConfig } = require('../config/runtime');
const createPool = require('../db/createPool');
const TokenRepository = require('../repositories/tokenRepository');

const ADDRESS_FIELD_FALLBACKS = [
  'contract_address',
  'contractaddress',
  'contract',
  'address',
  'target_address',
  'target',
  'token_address',
  'token'
];

const LABEL_FIELDS = ['label', 'name', 'contract_name', 'project', 'protocol', 'symbol'];
const TYPE_FIELDS = ['contract_type', 'type', 'category', 'tag', 'tags', 'standard'];
const SCORE_FIELDS = ['score', 'rank_score', 'quality_score', 'value_score'];
const FIRST_SEEN_FIELDS = ['first_seen_at', 'first_tx_time', 'created_at', 'created_time', 'creation_time', 'deploy_time', 'block_time'];
const LAST_SEEN_FIELDS = ['last_seen_at', 'last_tx_time', 'last_transaction_time', 'last_call_time', 'updated_at'];
const LAST_ACTIVITY_FIELDS = ['last_activity_at', 'last_tx_time', 'last_transaction_time', 'last_call_time'];
const LAST_TOKEN_ACTIVITY_FIELDS = ['last_token_activity_at', 'last_token_inflow_time', 'last_token_transfer_time'];

function parseArgs(argv) {
  const args = {
    chain: process.env.CHAIN_NAME || 'BSC',
    file: '',
    addressField: process.env.IMPORT_CONTRACT_ADDRESS_FIELD || 'contract_address',
    source: process.env.IMPORT_SOURCE || 'dune',
    dataset: process.env.IMPORT_DATASET || '',
    importLimit: Number(process.env.IMPORT_LIMIT || 0),
    batchSize: Number(process.env.IMPORT_BATCH_SIZE || 1000),
    nonTokenOnly: process.env.IMPORT_NON_TOKEN_ONLY === '1' || process.env.IMPORT_NON_TOKEN_ONLY === 'true',
    dryRun: process.env.SCAN_DRY_RUN === '1' || process.env.SCAN_DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--chain' || item === '-c') {
      args.chain = argv[++i];
    } else if (item === '--file' || item === '-f') {
      args.file = argv[++i];
    } else if (item === '--address-field') {
      args.addressField = argv[++i];
    } else if (item === '--source') {
      args.source = argv[++i];
    } else if (item === '--dataset') {
      args.dataset = argv[++i];
    } else if (item === '--import-limit') {
      args.importLimit = Number(argv[++i]);
    } else if (item === '--batch-size') {
      args.batchSize = Number(argv[++i]);
    } else if (item === '--non-token-only') {
      args.nonTokenOnly = true;
    } else if (item === '--dry-run') {
      args.dryRun = true;
    }
  }

  args.importLimit = normalizePositiveNumber(args.importLimit, 0);
  args.batchSize = normalizePositiveNumber(args.batchSize, 1000);

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

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase();
}

function getField(row, fields) {
  const normalizedRow = new Map(Object.entries(row || {}).map(([key, value]) => [normalizeKey(key), value]));
  for (const field of fields) {
    const value = normalizedRow.get(normalizeKey(field));
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }

  return null;
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

function parseDateValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const raw = String(value).trim();
  const normalized = raw.endsWith(' UTC') ? raw.replace(' UTC', 'Z').replace(' ', 'T') : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function parseNumberValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? String(value).replace(/,/g, '') : null;
}

function cleanRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [
      key,
      value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
    ])
  );
}

function buildMetrics(row) {
  const metrics = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null || String(value).trim() === '') {
      continue;
    }

    const parsed = Number(String(value).replace(/,/g, ''));
    if (Number.isFinite(parsed)) {
      metrics[key] = parsed;
    }
  }

  return metrics;
}

function buildAsset(row, addressField, args) {
  const raw = cleanRow(row);
  const requestedAddress = getField(raw, [addressField]);
  const fallbackAddress = getField(raw, ADDRESS_FIELD_FALLBACKS);
  const contractAddress = normalizeAddress(requestedAddress || fallbackAddress);
  if (!contractAddress) {
    return null;
  }

  return {
    contractAddress,
    assetKind: 'contract',
    contractType: stringOrNull(getField(raw, TYPE_FIELDS)),
    source: args.source,
    dataset: args.dataset,
    label: stringOrNull(getField(raw, LABEL_FIELDS)),
    score: parseNumberValue(getField(raw, SCORE_FIELDS)),
    firstSeenAt: parseDateValue(getField(raw, FIRST_SEEN_FIELDS)),
    lastSeenAt: parseDateValue(getField(raw, LAST_SEEN_FIELDS)),
    lastActivityAt: parseDateValue(getField(raw, LAST_ACTIVITY_FIELDS)),
    lastTokenActivityAt: parseDateValue(getField(raw, LAST_TOKEN_ACTIVITY_FIELDS)),
    metrics: buildMetrics(raw),
    raw
  };
}

function stringOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 255) : null;
}

async function* streamCsvRows(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = [];
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }

    if (lineNumber === 1) {
      headers = parseCsvLine(line);
      continue;
    }

    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    yield row;
  }
}

async function* streamJsonlRows(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    const row = JSON.parse(line);
    yield typeof row === 'string' ? { address: row } : row;
  }
}

async function* streamJsonRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.data || payload.rows || [];

  for (const row of rows) {
    yield typeof row === 'string' ? { address: row } : row;
  }
}

async function* streamTextRows(filePath) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    for (const value of line.split(',')) {
      if (value.trim()) {
        yield { address: value.trim() };
      }
    }
  }
}

function streamRows(filePath) {
  const absolutePath = path.resolve(filePath);
  const ext = path.extname(absolutePath).toLowerCase();

  if (ext === '.csv') {
    return streamCsvRows(absolutePath);
  }
  if (ext === '.jsonl') {
    return streamJsonlRows(absolutePath);
  }
  if (ext === '.json') {
    return streamJsonRows(absolutePath);
  }

  return streamTextRows(absolutePath);
}

async function flushBatch(repository, chainConfig, args, batch) {
  const byAddress = new Map();
  for (const asset of batch) {
    byAddress.set(asset.contractAddress, asset);
  }

  const uniqueAssets = Array.from(byAddress.values());
  const knownTokenMap = await repository.getKnownTokenAssetMap(
    chainConfig,
    uniqueAssets.map(asset => asset.contractAddress)
  );
  const assets = uniqueAssets
    .map(asset => {
      const isKnownToken = knownTokenMap.has(asset.contractAddress);
      return {
        ...asset,
        assetKind: isKnownToken ? 'token' : 'contract',
        isKnownToken
      };
    })
    .filter(asset => !args.nonTokenOnly || !asset.isKnownToken);
  const knownTokens = uniqueAssets.filter(asset => knownTokenMap.has(asset.contractAddress)).length;

  if (args.dryRun) {
    return {
      affected: assets.length,
      knownTokens,
      skippedKnownTokens: uniqueAssets.length - assets.length
    };
  }

  return {
    affected: await repository.upsertContractAssetsBatch(chainConfig, assets),
    knownTokens,
    skippedKnownTokens: uniqueAssets.length - assets.length
  };
}

async function importContractAssets(repository, chainConfig, args) {
  if (!args.file) {
    throw new Error('导入模式需要 --file');
  }

  const dataset = args.dataset || path.basename(args.file, path.extname(args.file));
  const runtimeArgs = { ...args, dataset };
  const limit = args.importLimit > 0 ? args.importLimit : Number.POSITIVE_INFINITY;
  let parsed = 0;
  let valid = 0;
  let invalid = 0;
  let affected = 0;
  let knownTokens = 0;
  let skippedKnownTokens = 0;
  let batch = [];

  console.log(`[${chainConfig.key}] 合约资产导入开始 file=${args.file} source=${args.source} dataset=${dataset} importLimit=${Number.isFinite(limit) ? limit : 'all'} batchSize=${args.batchSize} nonTokenOnly=${args.nonTokenOnly}`);

  for await (const row of streamRows(args.file)) {
    parsed += 1;
    const asset = buildAsset(row, args.addressField, runtimeArgs);
    if (!asset) {
      invalid += 1;
    } else {
      valid += 1;
      batch.push(asset);
    }

    if (batch.length >= args.batchSize) {
      const result = await flushBatch(repository, chainConfig, runtimeArgs, batch);
      affected += result.affected;
      knownTokens += result.knownTokens;
      skippedKnownTokens += result.skippedKnownTokens;
      batch = [];
      logProgress(chainConfig, parsed, valid, invalid, affected, knownTokens, skippedKnownTokens);
    }

    if (parsed >= limit) {
      break;
    }
  }

  if (batch.length > 0) {
    const result = await flushBatch(repository, chainConfig, runtimeArgs, batch);
    affected += result.affected;
    knownTokens += result.knownTokens;
    skippedKnownTokens += result.skippedKnownTokens;
  }

  console.log(`[${chainConfig.key}] 合约资产导入完成 parsed=${parsed} valid=${valid} invalid=${invalid} affected=${affected} knownTokens=${knownTokens} skippedKnownTokens=${skippedKnownTokens}`);
}

function logProgress(chainConfig, parsed, valid, invalid, affected, knownTokens, skippedKnownTokens) {
  if (parsed % 100000 === 0 || parsed < 100000) {
    console.log(`[${chainConfig.key}] 合约资产导入进度 parsed=${parsed} valid=${valid} invalid=${invalid} affected=${affected} knownTokens=${knownTokens} skippedKnownTokens=${skippedKnownTokens}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chainConfig = getChainConfig(args.chain);
  const pool = createPool(chainConfig.db);
  const repository = new TokenRepository(pool);

  try {
    await repository.testConnection();
    await repository.migrateAveSchema();
    await importContractAssets(repository, chainConfig, args);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[import-contract-assets] 失败: ${error.message}`);
  process.exit(1);
});
