#!/usr/bin/env node

process.env.CHAIN_NAME = process.env.CHAIN_NAME || 'BSC';
process.env.UPDATE_LIMIT = process.env.UPDATE_LIMIT || '5000';
process.env.STALE_AFTER_MS = process.env.STALE_AFTER_MS || String(60 * 60 * 1000);

require('./src/apps/scan-worker');
