#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getChainConfig } = require('../config/runtime');
const createPool = require('../db/createPool');
const TokenRepository = require('../repositories/tokenRepository');
const { isCakeLpToken, isKnownLpToken } = require('../lib/tokenFilters');

const TOKEN_FIELDS = ['token_address', 'tokenaddress', 'contract_address', 'contractaddress', 'token', 'address'];

function parseArgs(argv) {
  const args = {
    chain: process.env.CHAIN_NAME || 'BSC',
    file: '',
    mode: process.env.FILTER_MODE || 'known-lp',
    batchSize: Number(process.env.FILTER_BATCH_SIZE || 5000),
    dryRun: process.env.SCAN_DRY_RUN === '1' || process.env.SCAN_DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--chain' || item === '-c') {
      args.chain = argv[++i];
    } else if (item === '--file' || item === '-f') {
      args.file = argv[++i];
    } else if (item === '--mode') {
      args.mode = argv[++i] || 'known-lp';
    } else if (item === '--batch-size') {
      args.batchSize = Number(argv[++i]);
    } else if (item === '--dry-run') {
      args.dryRun = true;
    }
  }

  args.batchSize = Math.max(1, Number.parseInt(args.batchSize, 10) || 5000);
  return args;
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

function findField(headers, fields) {
  const normalized = headers.map(header => header.trim().toLowerCase());
  return normalized.findIndex(header => fields.includes(header));
}

function normalizeAddress(value) {
  const address = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : '';
}

async function* streamCsvRows(filePath) {
  const input = fs.createReadStream(path.resolve(filePath), { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let indexes = null;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    if (!indexes) {
      const headers = parseCsvLine(line);
      indexes = {
        token: findField(headers, TOKEN_FIELDS),
        symbol: findField(headers, ['symbol']),
        name: findField(headers, ['name'])
      };
      if (indexes.token < 0) {
        throw new Error('CSV 缺少 token/contract_address 字段');
      }
      continue;
    }

    const values = parseCsvLine(line);
    const tokenAddress = normalizeAddress(values[indexes.token]);
    if (!tokenAddress) {
      continue;
    }

    yield {
      tokenAddress,
      symbol: indexes.symbol >= 0 ? values[indexes.symbol] : '',
      name: indexes.name >= 0 ? values[indexes.name] : ''
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    throw new Error('需要 --file');
  }

  const chainConfig = getChainConfig(args.chain);
  const pool = createPool(chainConfig.db);
  const repository = new TokenRepository(pool);
  const filter = args.mode === 'cake-lp' ? isCakeLpToken : isKnownLpToken;
  const label = args.mode === 'cake-lp' ? 'CAKE LP' : 'LP';
  let matched = 0;
  let disabled = 0;
  let batch = [];

  try {
    await repository.testConnection();
    await repository.migrateAveSchema();

    for await (const row of streamCsvRows(args.file)) {
      if (!filter(row)) {
        continue;
      }

      matched += 1;
      batch.push(row.tokenAddress);
      if (batch.length >= args.batchSize) {
        disabled += await flushBatch(repository, chainConfig, args, batch);
        batch = [];
        console.log(`[${chainConfig.key}] ${label} 过滤进度 matched=${matched} disabled=${disabled}`);
      }
    }

    if (batch.length > 0) {
      disabled += await flushBatch(repository, chainConfig, args, batch);
    }

    console.log(`[${chainConfig.key}] ${label} 过滤完成 matched=${matched} disabled=${disabled}`);
  } finally {
    await pool.end();
  }
}

async function flushBatch(repository, chainConfig, args, batch) {
  if (args.dryRun) {
    return Array.from(new Set(batch)).length;
  }

  return repository.disableScanTokensBatch(chainConfig, batch, `filtered_${args.mode}_from_dune`);
}

main().catch(error => {
  console.error(`[filter-scan-tokens] 失败: ${error.message}`);
  process.exit(1);
});
