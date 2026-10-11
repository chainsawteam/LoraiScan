const FACTORY_GET_PAIR = {
  name: 'getPair',
  type: 'function',
  constant: true,
  inputs: [
    { name: 'tokenA', type: 'address' },
    { name: 'tokenB', type: 'address' }
  ],
  outputs: [{ name: 'pair', type: 'address' }]
};

const FACTORY_GET_POOL = {
  name: 'getPool',
  type: 'function',
  constant: true,
  inputs: [
    { name: 'tokenA', type: 'address' },
    { name: 'tokenB', type: 'address' },
    { name: 'fee', type: 'uint24' }
  ],
  outputs: [{ name: 'pool', type: 'address' }]
};

const CHAINLINK_DECIMALS = {
  name: 'decimals',
  type: 'function',
  constant: true,
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }]
};

const CHAINLINK_LATEST_ROUND_DATA = {
  name: 'latestRoundData',
  type: 'function',
  constant: true,
  inputs: [],
  outputs: [
    { name: 'roundId', type: 'uint80' },
    { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' }
  ]
};

const PAIR_TOKEN0 = {
  name: 'token0',
  type: 'function',
  constant: true,
  inputs: [],
  outputs: [{ name: '', type: 'address' }]
};

const PAIR_GET_RESERVES = {
  name: 'getReserves',
  type: 'function',
  constant: true,
  inputs: [],
  outputs: [
    { name: 'reserve0', type: 'uint112' },
    { name: 'reserve1', type: 'uint112' },
    { name: 'blockTimestampLast', type: 'uint32' }
  ]
};

const DEFAULT_V3_FEES = [100, 500, 2500, 3000, 10000];

class FactoryLiquidityResolver {
  constructor(web3, chainConfig, quoteTokens = {}) {
    this.web3 = web3;
    this.chainConfig = chainConfig;
    this.quoteTokens = quoteTokens || {};
    this.nativePriceCache = { value: 0, expiresAt: 0 };
  }

  isEnabled() {
    const calibration = this.chainConfig.scan?.calibration || {};
    return Boolean(calibration.enabled) && calibration.factoryLookupEnabled !== false;
  }

  isReady() {
    return this.isEnabled() && Boolean(this.web3);
  }

  async resolvePairs(tokenAddress) {
    if (!this.isReady()) {
      return {
        enabled: this.isEnabled(),
        pairs: [],
        errors: this.isEnabled() ? ['missing_web3'] : []
      };
    }

    const token = normalizeAddress(tokenAddress);
    if (!this.web3.utils.isAddress(token) || this.quoteTokens[token]) {
      return { enabled: true, pairs: [], errors: [] };
    }

    const factories = this.factoryConfigs();
    const quotes = Object.entries(this.quoteTokens)
      .map(([address, meta]) => ({ address, meta }))
      .filter(item => this.web3.utils.isAddress(item.address) && item.address !== token);
    const pairs = [];
    const errors = [];
    const seen = new Set();

    for (const factory of factories) {
      for (const quote of quotes) {
        try {
          const quotePriceUsd = await this.resolveQuotePriceUsd(quote);
          if (!Number.isFinite(quotePriceUsd) || quotePriceUsd <= 0) {
            continue;
          }

          const resolved = factory.protocol === 'uniswap-v3'
            ? await this.resolveV3Pools(factory, token, quote, quotePriceUsd)
            : await this.resolveV2Pair(factory, token, quote, quotePriceUsd);
          for (const pair of resolved) {
            const key = normalizeAddress(pair.pair);
            if (!key || seen.has(key)) {
              continue;
            }

            seen.add(key);
            pairs.push(pair);
          }
        } catch (error) {
          errors.push(`${factory.sourceKey || factory.protocol}:${quote.address}:${error.message}`);
        }
      }
    }

    return { enabled: true, pairs, errors };
  }

  factoryConfigs() {
    const configs = this.chainConfig.scan?.calibration?.factories
      || this.chainConfig.scan?.discoveries
      || [this.chainConfig.scan?.discovery]
      || [];

    return configs
      .map(config => ({
        protocol: normalizeProtocol(config?.protocol),
        sourceKey: config?.sourceKey || config?.name || config?.protocol || 'factory',
        factoryAddress: normalizeAddress(config?.factoryAddress)
      }))
      .filter(config => (
        (config.protocol === 'uniswap-v2' || config.protocol === 'uniswap-v3')
        && this.web3.utils.isAddress(config.factoryAddress)
      ));
  }

  async resolveV2Pair(factory, token, quote, quotePriceUsd) {
    const data = this.web3.eth.abi.encodeFunctionCall(FACTORY_GET_PAIR, [token, quote.address]);
    const raw = await this.web3.eth.call({ to: factory.factoryAddress, data });
    const pair = this.parseAddress(raw);
    if (!pair || !(await this.hasCode(pair))) {
      return [];
    }

    return [this.buildPairRecord({
      token,
      quote,
      quotePriceUsd,
      pair,
      protocol: factory.protocol,
      sourceKey: factory.sourceKey
    })];
  }

  async resolveV3Pools(factory, token, quote, quotePriceUsd) {
    const fees = this.v3Fees();
    const pairs = [];

    for (const fee of fees) {
      const data = this.web3.eth.abi.encodeFunctionCall(FACTORY_GET_POOL, [token, quote.address, fee]);
      const raw = await this.web3.eth.call({ to: factory.factoryAddress, data });
      const pool = this.parseAddress(raw);
      if (!pool || !(await this.hasCode(pool))) {
        continue;
      }

      pairs.push(this.buildPairRecord({
        token,
        quote,
        quotePriceUsd,
        pair: pool,
        protocol: factory.protocol,
        sourceKey: factory.sourceKey,
        fee
      }));
    }

    return pairs;
  }

  buildPairRecord({ token, quote, quotePriceUsd, pair, protocol, sourceKey, fee = null }) {
    const [token0, token1] = sortAddresses(token, quote.address);
    const quoteIsToken0 = token0 === quote.address;
    const quoteMeta = quote.meta || {};

    return {
      pair,
      amm: fee === null ? sourceKey : `${sourceKey}:${fee}`,
      protocol,
      factory_source: sourceKey,
      factory_discovered: true,
      factory_fee: fee,
      token0_address: token0,
      token0_symbol: quoteIsToken0 ? quoteMeta.symbol : null,
      token1_address: token1,
      token1_symbol: quoteIsToken0 ? null : quoteMeta.symbol,
      reserve0: 0,
      reserve1: 0,
      token0_price_usd: quoteIsToken0 ? quotePriceUsd : 0,
      token1_price_usd: quoteIsToken0 ? 0 : quotePriceUsd,
      pair_tvl_usd: 0
    };
  }

  async resolveQuotePriceUsd(quote) {
    const meta = quote.meta || {};
    const direct = Number(meta.priceUsd);
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }

    const symbol = String(meta.symbol || '').toUpperCase();
    if (['USDT', 'USDC', 'USDBC', 'BUSD', 'FDUSD', 'DAI', 'FRAX'].includes(symbol)) {
      return 1;
    }

    const native = this.chainConfig.scan?.methodCallMonitor?.nativeAsset || {};
    if (
      normalizeAddress(native.wrappedAddress) === quote.address
      || meta.nativePriced
    ) {
      return await this.nativePriceUsd(native);
    }

    return 0;
  }

  async nativePriceUsd(native) {
    const now = Date.now();
    if (this.nativePriceCache.expiresAt > now) {
      return this.nativePriceCache.value;
    }

    let price = 0;
    try {
      price = await this.fetchNativePriceFromChainlink(native);
      if (!price) {
        price = await this.fetchNativePriceFromPair(native);
      }
    } catch {
      price = Number(native?.fallbackPriceUsd || 0);
    }

    this.nativePriceCache = {
      value: Number.isFinite(price) ? price : 0,
      expiresAt: now + Math.max(1000, Number(native?.priceTtlMs || 5 * 60 * 1000))
    };
    return this.nativePriceCache.value;
  }

  async fetchNativePriceFromChainlink(native) {
    const feed = normalizeAddress(native?.chainlinkFeedAddress);
    if (!feed || !this.web3.utils.isAddress(feed)) {
      return 0;
    }

    const decimalsRaw = await this.web3.eth.call({
      to: feed,
      data: this.web3.eth.abi.encodeFunctionCall(CHAINLINK_DECIMALS, [])
    });
    const decimals = Number(this.web3.eth.abi.decodeParameter('uint8', decimalsRaw));
    const raw = await this.web3.eth.call({
      to: feed,
      data: this.web3.eth.abi.encodeFunctionCall(CHAINLINK_LATEST_ROUND_DATA, [])
    });
    const decoded = this.web3.eth.abi.decodeParameters(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], raw);
    const answer = BigInt(decoded[1]);
    if (answer <= 0n) {
      return 0;
    }

    return Number(answer.toString()) / (10 ** decimals);
  }

  async fetchNativePriceFromPair(native) {
    const wrappedNative = normalizeAddress(native?.wrappedAddress);
    const stable = normalizeAddress(native?.priceTokenAddress);
    const factory = normalizeAddress(native?.priceFactoryAddress);
    const stableDecimals = Number(native?.priceTokenDecimals || 18);
    if (!wrappedNative || !stable || !factory) {
      return Number(native?.fallbackPriceUsd || 0);
    }

    const pairData = this.web3.eth.abi.encodeFunctionCall(FACTORY_GET_PAIR, [wrappedNative, stable]);
    const pairRaw = await this.web3.eth.call({ to: factory, data: pairData });
    const pair = this.parseAddress(pairRaw);
    if (!pair) {
      return Number(native?.fallbackPriceUsd || 0);
    }

    const token0Raw = await this.web3.eth.call({
      to: pair,
      data: this.web3.eth.abi.encodeFunctionCall(PAIR_TOKEN0, [])
    });
    const token0 = this.parseAddress(token0Raw);
    const reservesRaw = await this.web3.eth.call({
      to: pair,
      data: this.web3.eth.abi.encodeFunctionCall(PAIR_GET_RESERVES, [])
    });
    const reserves = this.web3.eth.abi.decodeParameters(['uint112', 'uint112', 'uint32'], reservesRaw);
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const nativeReserve = token0 === wrappedNative ? reserve0 : reserve1;
    const stableReserve = token0 === wrappedNative ? reserve1 : reserve0;
    const nativeAmount = formatUnits(nativeReserve, Number(native?.decimals || 18));
    const stableAmount = formatUnits(stableReserve, stableDecimals);
    return nativeAmount > 0 ? stableAmount / nativeAmount : Number(native?.fallbackPriceUsd || 0);
  }

  v3Fees() {
    const configured = this.chainConfig.scan?.calibration?.v3Fees || [];
    return configured.length > 0 ? configured : DEFAULT_V3_FEES;
  }

  async hasCode(address) {
    const code = await this.web3.eth.getCode(address);
    return Boolean(code && code !== '0x');
  }

  parseAddress(value) {
    const hex = String(value || '').replace(/^0x/i, '').padStart(64, '0');
    if (!hex || /^0+$/.test(hex)) {
      return '';
    }

    const address = `0x${hex.slice(-40)}`.toLowerCase();
    return this.web3.utils.isAddress(address) ? address : '';
  }
}

function normalizeProtocol(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value.includes('v3')) {
    return 'uniswap-v3';
  }
  if (value.includes('v2')) {
    return 'uniswap-v2';
  }
  return value;
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  if (!value) {
    return '';
  }
  if (value.startsWith('0x') || value.startsWith('0X')) {
    return `0x${value.slice(2).toLowerCase()}`;
  }
  return value.toLowerCase();
}

function sortAddresses(a, b) {
  return normalizeAddress(a) < normalizeAddress(b)
    ? [normalizeAddress(a), normalizeAddress(b)]
    : [normalizeAddress(b), normalizeAddress(a)];
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

module.exports = FactoryLiquidityResolver;
