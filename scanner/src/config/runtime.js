require('dotenv').config();

const chainDefinitions = require('./chains');

function parseChainList(value) {
  if (!value) {
    return ['BSC'];
  }

  return value
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

function getChainConfig(chainName) {
  const normalized = String(chainName || '').trim().toUpperCase();
  const config = chainDefinitions[normalized];

  if (!config) {
    throw new Error(`未知链配置: ${chainName}`);
  }

  return {
    key: normalized,
    ...config
  };
}

function getEnabledChains() {
  const enabledKeys = parseChainList(process.env.SCAN_CHAINS);
  return enabledKeys.map(getChainConfig);
}

module.exports = {
  getChainConfig,
  getEnabledChains
};
