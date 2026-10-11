function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-./()]+/g, '');
}

function isCakeLpToken(token = {}) {
  const symbol = normalizeLabel(token.symbol);
  const name = normalizeLabel(token.name);

  return symbol === 'cakelp'
    || name === 'cakelp'
    || name === 'pancakelps'
    || name === 'pancakelptoken';
}

function isKnownLpToken(token = {}) {
  const symbol = normalizeLabel(token.symbol);
  const name = normalizeLabel(token.name);

  if (isCakeLpToken(token)) {
    return true;
  }

  if (symbol === 'univ2' && name === 'uniswapv2') {
    return true;
  }

  if (name === 'sushiswaplptoken' || name === 'shibaswaplptoken') {
    return true;
  }

  if (name === 'balancerpooltoken') {
    return true;
  }

  return name.endsWith('lptoken')
    || name.endsWith('pooltoken')
    || name.includes('liquiditypool');
}

module.exports = {
  isCakeLpToken,
  isKnownLpToken
};
