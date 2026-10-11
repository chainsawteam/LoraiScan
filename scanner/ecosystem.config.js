const { getEnabledChains } = require('./src/config/runtime');

module.exports = {
  apps: getEnabledChains().map(chain => ({
    name: `token-scan-${chain.key.toLowerCase()}`,
    cwd: __dirname,
    script: './src/apps/scan-worker.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      CHAIN_NAME: chain.key,
      SCAN_DRY_RUN: process.env.SCAN_DRY_RUN || '0'
    }
  }))
};
