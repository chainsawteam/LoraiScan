const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function'
  }
];

const DEFAULT_QUOTE_TOKENS = {
  BSC: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18 },
    '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409': { symbol: 'FDUSD', decimals: 18 },
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': { symbol: 'DAI', decimals: 18 },
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': { symbol: 'BTCB', decimals: 18 },
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { symbol: 'ETH', decimals: 18 }
  },
  ETH: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0x853d955acef822db058eb8505911ed77f175b99e': { symbol: 'FRAX', decimals: 18 },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 }
  },
  BASE: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 }
  },
  ROBIN: {
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18, nativePriced: true },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, priceUsd: 1 }
  }
};

class PoolLiquidityCalibrator {
  constructor(web3, chainConfig) {
    this.web3 = web3;
    this.chainConfig = chainConfig;
    this.contractCache = new Map();
    this.quoteTokens = {
      ...(DEFAULT_QUOTE_TOKENS[chainConfig.key] || {}),
      ...(chainConfig.scan?.calibration?.quoteTokens || {})
    };
    this.maxPairs = Number(chainConfig.scan?.calibration?.maxPairs || 10);
  }

  isEnabled() {
    return Boolean(this.chainConfig.scan?.calibration?.enabled);
  }

  isReady() {
    return this.isEnabled() && Boolean(this.web3);
  }

  async calibratePairs(pairs) {
    if (!this.isReady()) {
      return {
        enabled: this.isEnabled(),
        calibratedPairs: pairs || [],
        calibratedLiquidityUsd: this.computeTotalLiquidityUsd(pairs),
        calibrations: [],
        errors: this.isEnabled() ? ['missing_web3'] : []
      };
    }

    const calibratedPairs = [];
    const calibrations = [];
    const errors = [];
    let processed = 0;

    for (const pair of pairs || []) {
      if (!pair?.pair || processed >= this.maxPairs) {
        calibratedPairs.push(pair);
        continue;
      }

      const quoteSides = this.quoteSides(pair);
      if (quoteSides.length === 0) {
        calibratedPairs.push(pair);
        continue;
      }

      processed += 1;
      try {
        const result = await this.calibratePair(pair, quoteSides);
        calibratedPairs.push(result.pair);
        calibrations.push(result.calibration);
      } catch (error) {
        calibratedPairs.push({
          ...pair,
          calibration_error: error.message
        });
        errors.push(`${pair.pair}:${error.message}`);
      }
    }

    return {
      enabled: true,
      calibratedPairs,
      calibratedLiquidityUsd: this.computeTotalLiquidityUsd(calibratedPairs),
      calibrations,
      errors
    };
  }

  async calibratePair(pair, quoteSides) {
    const pairAddress = normalizeAddress(pair.pair);
    const updates = {};
    const quoteBalances = [];

    for (const side of quoteSides) {
      const quote = this.quoteTokens[side.address];
      const rawBalance = await this.balanceOf(side.address, pairAddress);
      const balance = formatUnits(rawBalance, quote.decimals);
      const priceUsd = this.resolvePriceUsd(pair, side.index, quote.symbol);
      const balanceUsd = Number.isFinite(priceUsd) && priceUsd > 0 ? balance * priceUsd : 0;

      updates[`reserve${side.index}`] = balance;
      quoteBalances.push({
        token: side.address,
        symbol: quote.symbol,
        side: side.index,
        decimals: quote.decimals,
        rawBalance: rawBalance.toString(),
        balance,
        priceUsd,
        balanceUsd
      });
    }

    const calibratedTvlUsd = quoteBalances.length > 1
      ? quoteBalances.reduce((sum, item) => sum + item.balanceUsd, 0)
      : quoteBalances[0].balanceUsd * 2;
    const originalTvlUsd = Number(pair.pair_tvl_usd);

    const calibratedPair = {
      ...pair,
      ...updates,
      pair_tvl_usd: Number.isFinite(calibratedTvlUsd) ? calibratedTvlUsd : 0,
      liquidity_calibrated: true,
      liquidity_calibration: {
        method: 'erc20_balanceOf_pair_quote',
        quoteBalances,
        originalPairTvlUsd: Number.isFinite(originalTvlUsd) ? originalTvlUsd : null,
        calibratedPairTvlUsd: Number.isFinite(calibratedTvlUsd) ? calibratedTvlUsd : 0,
        calibratedAt: new Date().toISOString()
      }
    };

    return {
      pair: calibratedPair,
      calibration: {
        pair: pairAddress,
        originalPairTvlUsd: Number.isFinite(originalTvlUsd) ? originalTvlUsd : 0,
        calibratedPairTvlUsd: calibratedPair.pair_tvl_usd,
        quoteBalances
      }
    };
  }

  quoteSides(pair) {
    const sides = [];
    const token0 = normalizeAddress(pair.token0_address);
    const token1 = normalizeAddress(pair.token1_address);

    if (this.quoteTokens[token0]) {
      sides.push({ index: 0, address: token0 });
    }
    if (this.quoteTokens[token1]) {
      sides.push({ index: 1, address: token1 });
    }

    return sides;
  }

  resolvePriceUsd(pair, sideIndex, symbol) {
    const direct = Number(pair[`token${sideIndex}_price_usd`]);
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }

    const sideAddress = normalizeAddress(pair[`token${sideIndex}_address`]);
    const quote = this.quoteTokens[sideAddress];
    const configured = Number(quote?.priceUsd);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }

    const stableSymbols = new Set(['USDT', 'USDC', 'USDBC', 'BUSD', 'FDUSD', 'DAI', 'FRAX']);
    return stableSymbols.has(String(symbol || '').toUpperCase()) ? 1 : 0;
  }

  async balanceOf(tokenAddress, account) {
    const token = normalizeAddress(tokenAddress);
    let contract = this.contractCache.get(token);
    if (!contract) {
      contract = new this.web3.eth.Contract(ERC20_ABI, token);
      this.contractCache.set(token, contract);
    }

    return BigInt(await contract.methods.balanceOf(account).call());
  }

  computeTotalLiquidityUsd(pairs, options = {}) {
    return (pairs || []).reduce((total, pair) => {
      if (options.calibratedOnly && !pair?.liquidity_calibrated) {
        return total;
      }

      const pairTvl = Number(pair?.pair_tvl_usd);
      if (Number.isFinite(pairTvl) && pairTvl > 0) {
        return total + pairTvl;
      }

      const reserve0 = Number(pair?.reserve0);
      const reserve1 = Number(pair?.reserve1);
      const price0 = Number(pair?.token0_price_usd);
      const price1 = Number(pair?.token1_price_usd);
      const computed = reserve0 * price0 + reserve1 * price1;
      return Number.isFinite(computed) && computed > 0 ? total + computed : total;
    }, 0);
  }
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (value.startsWith('0x') || value.startsWith('0X')) {
    return `0x${value.slice(2).toLowerCase()}`;
  }
  return value.toLowerCase();
}

function formatUnits(rawValue, decimals) {
  const raw = BigInt(rawValue || 0);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;

  if (fraction === 0n) {
    return Number(whole.toString());
  }

  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(`${whole.toString()}.${fractionText}`);
}

module.exports = {
  PoolLiquidityCalibrator,
  DEFAULT_QUOTE_TOKENS
};
