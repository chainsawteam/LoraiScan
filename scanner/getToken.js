#!/usr/bin/env node

process.env.CHAIN_NAME = process.env.CHAIN_NAME || 'BSC';

require('./src/apps/scan-worker');
