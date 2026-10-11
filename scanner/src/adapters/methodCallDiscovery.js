const LoraiAuditClient = require('../lib/loraiAuditClient');

const ERC20_BALANCE_OF = {
  name: 'balanceOf',
  type: 'function',
  inputs: [{ type: 'address', name: 'account' }],
  outputs: [{ type: 'uint256', name: 'balance' }]
};

const ERC20_TOTAL_SUPPLY = {
  name: 'totalSupply',
  type: 'function',
  inputs: [],
  outputs: [{ type: 'uint256', name: 'supply' }]
};

const ERC20_DECIMALS = {
  name: 'decimals',
  type: 'function',
  inputs: [],
  outputs: [{ type: 'uint8', name: 'decimals' }]
};

const ERC20_SYMBOL = {
  name: 'symbol',
  type: 'function',
  inputs: [],
  outputs: [{ type: 'string', name: 'symbol' }]
};

const FACTORY_GET_PAIR = {
  name: 'getPair',
  type: 'function',
  inputs: [
    { type: 'address', name: 'tokenA' },
    { type: 'address', name: 'tokenB' }
  ],
  outputs: [{ type: 'address', name: 'pair' }]
};

const PAIR_TOKEN0 = {
  name: 'token0',
  type: 'function',
  inputs: [],
  outputs: [{ type: 'address', name: 'token0' }]
};

const PAIR_GET_RESERVES = {
  name: 'getReserves',
  type: 'function',
  inputs: [],
  outputs: [
    { type: 'uint112', name: 'reserve0' },
    { type: 'uint112', name: 'reserve1' },
    { type: 'uint32', name: 'blockTimestampLast' }
  ]
};

const CHAINLINK_DECIMALS = {
  name: 'decimals',
  type: 'function',
  inputs: [],
  outputs: [{ type: 'uint8', name: 'decimals' }]
};

const CHAINLINK_LATEST_ROUND_DATA = {
  name: 'latestRoundData',
  type: 'function',
  inputs: [],
  outputs: [
    { type: 'uint80', name: 'roundId' },
    { type: 'int256', name: 'answer' },
    { type: 'uint256', name: 'startedAt' },
    { type: 'uint256', name: 'updatedAt' },
    { type: 'uint80', name: 'answeredInRound' }
  ]
};

class MethodCallDiscovery {
  constructor(web3, repository, chainConfig) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.config = chainConfig.scan?.methodCallMonitor || {};
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.processing = false;
    this.activeBlocks = 0;
    this.blockQueue = [];
    this.blockQueueKeys = new Set();
    this.lastAuditAttemptAt = new Map();
    this.nativePriceCache = { value: 0, expiresAt: 0 };
    this.erc20LikeCache = new Map();
  }

  startSubscription(options = {}) {
    if (!this.config.enabled || !this.config.subscribeEnabled) {
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] method-call subscription 已启用但缺少 web3 client`);
    }

    const selectors = this.selectorMap();
    if (selectors.size === 0) {
      console.log(`[${this.chainConfig.key}] method-call subscription 未配置 selector，跳过`);
      return null;
    }

    this.subscriptionOptions = { ...options, selectors };
    return this.openSubscription(this.subscriptionOptions);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const selectors = options.selectors || this.selectorMap();
    this.subscription = this.web3.eth.subscribe('newBlockHeaders');
    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] method-call subscription connected id=${id} ${this.selectorSummary(selectors)} minValueUsd=${this.minValueUsd()} filters=${this.filterSummary()}`);
      })
      .on('data', header => {
        this.enqueueBlock(header.number, { dryRun, selectors });
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] method-call subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] method-call subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] method-call subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.max(1000, Number(this.chainConfig.scan?.discovery?.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] method-call subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);
    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] method-call subscription reconnect failed: ${reconnectError.message}`);
        this.scheduleReconnect('reconnect_failed', reconnectError);
      }
    }, delayMs);
  }

  closeSubscription() {
    const subscription = this.subscription;
    this.subscription = null;
    if (!subscription) {
      return;
    }

    try {
      if (typeof subscription.unsubscribe === 'function') {
        subscription.unsubscribe(() => {});
      }
    } catch (_) {
      // Best effort cleanup; reconnect creates a fresh subscription.
    }
  }

  enqueueBlock(blockNumber, options = {}) {
    if (!blockNumber) {
      return;
    }
    const key = String(blockNumber);
    if (this.blockQueueKeys.has(key)) {
      return;
    }

    const maxQueuedBlocks = Math.max(1, Number(this.config.maxQueuedBlocks || 1000));
    if (this.blockQueue.length >= maxQueuedBlocks) {
      const dropped = this.blockQueue.shift();
      this.blockQueueKeys.delete(dropped.key);
      console.error(`[${this.chainConfig.key}] method-call queue 已满，丢弃最旧区块 block=${dropped.blockNumber}`);
    }

    this.blockQueue.push({ key, blockNumber, options });
    this.blockQueueKeys.add(key);
    this.drainBlockQueue();
  }

  drainBlockQueue() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      const maxConcurrentBlocks = Math.max(1, Number(this.config.maxConcurrentBlocks || 1));
      while (this.blockQueue.length > 0 && this.activeBlocks < maxConcurrentBlocks) {
        const item = this.blockQueue.shift();
        this.blockQueueKeys.delete(item.key);
        this.activeBlocks += 1;
        this.processBlock(item.blockNumber, item.options)
          .catch(error => {
            console.error(`[${this.chainConfig.key}] method-call block=${item.blockNumber || 'n/a'} 处理失败: ${error.message}`);
          })
          .finally(() => {
            this.activeBlocks -= 1;
            this.drainBlockQueue();
          });
      }
    } finally {
      this.processing = false;
    }
  }

  async processBlock(blockNumber, options = {}) {
    if (!blockNumber) {
      return;
    }

    const selectors = options.selectors || this.selectorMap();
    const block = await this.getRawBlock(blockNumber);
    const txs = Array.isArray(block?.transactions) ? block.transactions : [];
    const limit = Math.max(1, Number(this.config.maxTransactionsPerBlock || 2000));
    const matchedTxs = [];

    for (const tx of txs.slice(0, limit)) {
      const selector = String(tx.input || '').slice(0, 10).toLowerCase();
      if (!selectors.has(selector) || !tx.to) {
        continue;
      }

      matchedTxs.push({ tx, method: selectors.get(selector) });
    }

    if (matchedTxs.length === 0) {
      return;
    }

    const concurrency = Math.max(1, Number(this.config.maxConcurrentTransactions || 4));
    const results = await this.mapLimit(matchedTxs, concurrency, item => (
      this.handleTransaction(item.tx, item.method, options).catch(error => {
        console.error(`[${this.chainConfig.key}] method-call target=${item.tx.to || 'n/a'} method=${item.method.name || item.method.selector} tx=${item.tx.hash || 'n/a'} 处理失败: ${error.message}`);
        return { qualified: false };
      })
    ));
    const qualified = results.filter(result => result?.qualified).length;

    if (matchedTxs.length > 0) {
      console.log(`[${this.chainConfig.key}] method-call block=${blockNumber} txs=${txs.length} matched=${matchedTxs.length} qualified=${qualified}`);
    }
  }

  async handleTransaction(tx, method, options = {}) {
    const targetAddress = String(tx.to || '').toLowerCase();
    if (!this.web3.utils.isAddress(targetAddress)) {
      return { qualified: false };
    }

    const code = await this.getCodeWithTimeout(targetAddress);
    if (!code || code === '0x') {
      return { qualified: false };
    }

    const skippedReason = await this.skipTargetReason(targetAddress);
    if (skippedReason) {
      return { qualified: false };
    }

    const valuation = await this.valueContract(targetAddress);
    const thresholdUsd = this.minValueUsd();
    if (!Number.isFinite(valuation.totalUsd) || valuation.totalUsd < thresholdUsd) {
      console.log(`[${this.chainConfig.key}] method-call target=${targetAddress} method=${method.name} tx=${tx.hash || 'n/a'} 跳过 valueUsd=${this.formatUsd(valuation.totalUsd)} threshold=${thresholdUsd} assets=${this.formatAssets(valuation.assets)}`);
      return { qualified: false };
    }

    if (options.dryRun) {
      console.log(`[${this.chainConfig.key}] method-call [dry-run] target=${targetAddress} method=${method.name} tx=${tx.hash || 'n/a'} valueUsd=${this.formatUsd(valuation.totalUsd)} assets=${this.formatAssets(valuation.assets)}`);
      return { qualified: true };
    }

    if (!this.config.triggerAudit) {
      console.log(`[${this.chainConfig.key}] method-call target=${targetAddress} method=${method.name} LORAI 跳过 reason=audit_disabled valueUsd=${this.formatUsd(valuation.totalUsd)} assets=${this.formatAssets(valuation.assets)}`);
      return { qualified: true };
    }

    if (!this.shouldAttemptAudit(targetAddress)) {
      console.log(`[${this.chainConfig.key}] method-call target=${targetAddress} method=${method.name} 跳过 reason=cooldown valueUsd=${this.formatUsd(valuation.totalUsd)}`);
      return { qualified: true };
    }

    try {
      const result = await this.auditClient.ensureAudit(this.chainConfig, targetAddress, {
        priority: this.priority(),
        context: {
          source: 'method-call',
          method: method.name,
          selector: method.selector,
          txHash: tx.hash || ''
        }
      });
      console.log(
        `[${this.chainConfig.key}] method-call target=${targetAddress} method=${method.name} LORAI ${result.skipped ? `跳过 reason=${result.reason}` : `已触发 run_id=${result.runId || 'n/a'}`} valueUsd=${this.formatUsd(valuation.totalUsd)} assets=${this.formatAssets(valuation.assets)}`
      );
    } catch (error) {
      console.error(`[${this.chainConfig.key}] method-call target=${targetAddress} method=${method.name} LORAI 触发失败 valueUsd=${this.formatUsd(valuation.totalUsd)} err=${error.message}`);
    }

    return { qualified: true };
  }

  async valueContract(targetAddress) {
    const assets = [];
    let totalUsd = 0;
    const nativePriceUsd = await this.nativePriceUsd();
    const nativeBalanceRaw = await this.getBalanceWithTimeout(targetAddress);
    const nativeAmount = this.toDecimal(nativeBalanceRaw, this.config.nativeAsset?.decimals || 18);
    if (nativeAmount > 0) {
      const valueUsd = nativeAmount * nativePriceUsd;
      assets.push({
        symbol: this.config.nativeAsset?.symbol || 'BNB',
        amount: nativeAmount,
        priceUsd: nativePriceUsd,
        valueUsd
      });
      totalUsd += valueUsd;
    }

    for (const token of this.quoteTokens()) {
      const rawBalance = await this.balanceOf(token.address, targetAddress);
      const amount = this.toDecimal(rawBalance, token.decimals);
      if (amount <= 0) {
        continue;
      }

      const priceUsd = token.nativePriced ? nativePriceUsd : Number(token.priceUsd || 0);
      const valueUsd = amount * priceUsd;
      assets.push({
        symbol: token.symbol,
        address: token.address,
        amount,
        priceUsd,
        valueUsd
      });
      totalUsd += valueUsd;
    }

    return { totalUsd, assets };
  }

  async getRawBlock(blockNumber) {
    const blockTag = typeof blockNumber === 'string' && blockNumber.startsWith('0x')
      ? blockNumber
      : `0x${Number(blockNumber).toString(16)}`;
    const attempts = Math.max(1, Number(this.config.blockFetchRetries || this.config.rpcRetries || 1));
    let payload = null;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        payload = await this.rpcCall('eth_getBlockByNumber', [blockTag, true]);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await this.sleep(Math.min(1000, 200 * attempt));
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
    return {
      ...payload,
      transactions: (payload?.transactions || []).map(tx => ({
        hash: tx.hash,
        to: tx.to,
        input: tx.input || tx.data || '0x'
      }))
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  rpcCall(method, params) {
    return this.withTimeout(new Promise((resolve, reject) => {
      const provider = this.web3.currentProvider;
      const request = {
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      };
      const callback = (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        if (response?.error) {
          reject(new Error(response.error.message || JSON.stringify(response.error)));
          return;
        }
        resolve(response?.result || null);
      };

      if (provider.sendAsync) {
        provider.sendAsync(request, callback);
      } else {
        provider.send(request, callback);
      }
    }), `${method} ${Array.isArray(params) ? params[0] || '' : ''}`);
  }

  async balanceOf(tokenAddress, holderAddress) {
    const data = this.web3.eth.abi.encodeFunctionCall(ERC20_BALANCE_OF, [holderAddress]);
    const result = await this.callWithTimeout({ to: tokenAddress, data }, `balanceOf ${tokenAddress}`);
    return BigInt(result || '0x0');
  }

  async skipTargetReason(targetAddress) {
    if (this.denylist().has(targetAddress)) {
      return 'denylist';
    }

    if (this.config.skipObservedPools && this.repository?.getObservedPoolsByAddresses) {
      const poolMap = await this.repository.getObservedPoolsByAddresses(this.chainConfig, [targetAddress]);
      if (poolMap.has(targetAddress)) {
        return 'observed_pool';
      }
    }

    if (this.config.skipErc20LikeTargets && await this.isErc20Like(targetAddress)) {
      return 'erc20_like';
    }

    return '';
  }

  async isErc20Like(targetAddress) {
    if (this.erc20LikeCache.has(targetAddress)) {
      return this.erc20LikeCache.get(targetAddress);
    }

    let result = false;
    try {
      const [totalSupplyRaw, decimalsRaw, symbolRaw] = await Promise.all([
        this.callWithTimeout({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_TOTAL_SUPPLY, []) }, `totalSupply ${targetAddress}`),
        this.callWithTimeout({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_DECIMALS, []) }, `decimals ${targetAddress}`),
        this.callWithTimeout({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_SYMBOL, []) }, `symbol ${targetAddress}`)
      ]);
      const decimals = Number(BigInt(decimalsRaw || '0x0'));
      const totalSupply = BigInt(totalSupplyRaw || '0x0');
      const symbol = this.decodeSymbol(symbolRaw);
      result = totalSupply > 0n && decimals >= 0 && decimals <= 36 && Boolean(symbol);
    } catch (_error) {
      result = false;
    }

    this.erc20LikeCache.set(targetAddress, result);
    return result;
  }

  decodeSymbol(raw) {
    const value = String(raw || '');
    if (!value || value === '0x') {
      return '';
    }

    try {
      return String(this.web3.eth.abi.decodeParameter('string', value) || '').trim();
    } catch (_error) {
      const hex = value.replace(/^0x/i, '').slice(0, 64);
      const bytes = Buffer.from(hex, 'hex');
      return bytes.toString('utf8').replace(/\0/g, '').trim();
    }
  }

  async nativePriceUsd() {
    const now = Date.now();
    if (this.nativePriceCache.expiresAt > now) {
      return this.nativePriceCache.value;
    }

    let price = 0;
    try {
      price = await this.fetchNativePriceFromPair();
    } catch (error) {
      const fallback = Number(this.config.nativeAsset?.fallbackPriceUsd || 0);
      price = Number.isFinite(fallback) ? fallback : 0;
      console.warn(`[${this.chainConfig.key}] method-call native price 查询失败，使用 fallback=${price}: ${error.message}`);
    }

    this.nativePriceCache = {
      value: Number.isFinite(price) ? price : 0,
      expiresAt: now + Math.max(1000, Number(this.config.nativeAsset?.priceTtlMs || 5 * 60 * 1000))
    };
    return this.nativePriceCache.value;
  }

  async fetchNativePriceFromPair() {
    const native = this.config.nativeAsset || {};
    const feedPrice = await this.fetchNativePriceFromChainlink(native);
    if (feedPrice > 0) {
      return feedPrice;
    }

    const wrappedNative = String(native.wrappedAddress || '').toLowerCase();
    const stable = String(native.priceTokenAddress || '').toLowerCase();
    const factory = String(native.priceFactoryAddress || '').toLowerCase();
    const stableDecimals = Number(native.priceTokenDecimals || 18);
    if (!wrappedNative || !stable || !factory) {
      return Number(native.fallbackPriceUsd || 0);
    }

    const getPairData = this.web3.eth.abi.encodeFunctionCall(FACTORY_GET_PAIR, [wrappedNative, stable]);
    const pairRaw = await this.callWithTimeout({ to: factory, data: getPairData }, `getPair ${factory}`);
    const pair = this.parseAddress(pairRaw);
    if (!pair) {
      return Number(native.fallbackPriceUsd || 0);
    }

    const token0Raw = await this.callWithTimeout({
      to: pair,
      data: this.web3.eth.abi.encodeFunctionCall(PAIR_TOKEN0, [])
    }, `token0 ${pair}`);
    const token0 = this.parseAddress(token0Raw);
    const reservesRaw = await this.callWithTimeout({
      to: pair,
      data: this.web3.eth.abi.encodeFunctionCall(PAIR_GET_RESERVES, [])
    }, `getReserves ${pair}`);
    const reserves = this.web3.eth.abi.decodeParameters(['uint112', 'uint112', 'uint32'], reservesRaw);
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const nativeReserve = token0 === wrappedNative ? reserve0 : reserve1;
    const stableReserve = token0 === wrappedNative ? reserve1 : reserve0;
    const nativeAmount = this.toDecimal(nativeReserve, native.decimals || 18);
    const stableAmount = this.toDecimal(stableReserve, stableDecimals);
    return nativeAmount > 0 ? stableAmount / nativeAmount : Number(native.fallbackPriceUsd || 0);
  }

  async fetchNativePriceFromChainlink(native) {
    const feed = String(native.chainlinkFeedAddress || '').toLowerCase();
    if (!feed || !this.web3.utils.isAddress(feed)) {
      return 0;
    }

    const decimalsRaw = await this.callWithTimeout({
      to: feed,
      data: this.web3.eth.abi.encodeFunctionCall(CHAINLINK_DECIMALS, [])
    }, `chainlink decimals ${feed}`);
    const decimals = Number(BigInt(decimalsRaw || '0x0'));
    const dataRaw = await this.callWithTimeout({
      to: feed,
      data: this.web3.eth.abi.encodeFunctionCall(CHAINLINK_LATEST_ROUND_DATA, [])
    }, `chainlink latestRoundData ${feed}`);
    const decoded = this.web3.eth.abi.decodeParameters(['uint80', 'int256', 'uint256', 'uint256', 'uint80'], dataRaw);
    const answer = BigInt(decoded[1]);
    const updatedAt = Number(decoded[3] || 0);
    if (answer <= 0n || updatedAt <= 0) {
      return 0;
    }

    return this.toDecimal(answer, decimals);
  }

  selectorMap() {
    const selectors = new Map();
    for (const item of this.config.methods || []) {
      const selector = String(item.selector || '').trim().toLowerCase();
      if (/^0x[a-f0-9]{8}$/.test(selector)) {
        selectors.set(selector, {
          selector,
          name: item.name || selector,
          signature: item.name || ''
        });
      }
    }
    for (const signature of this.config.signatures || []) {
      const normalized = this.normalizeSignature(signature);
      if (!normalized) {
        continue;
      }

      const hash = this.web3.utils.sha3(normalized);
      const selector = String(hash || '').slice(0, 10).toLowerCase();
      if (!/^0x[a-f0-9]{8}$/.test(selector) || selectors.has(selector)) {
        continue;
      }

      selectors.set(selector, {
        selector,
        name: normalized.split('(')[0],
        signature: normalized
      });
    }
    return selectors;
  }

  selectorSummary(selectors) {
    const values = Array.from(selectors.values());
    const sample = values
      .slice(0, 12)
      .map(item => `${item.signature || item.name || item.selector}:${item.selector}`)
      .join(',');
    return `selectors=${values.length}${sample ? ` sample=${sample}${values.length > 12 ? ',...' : ''}` : ''}`;
  }

  normalizeSignature(signature) {
    const value = String(signature || '').replace(/\s+/g, '');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)$/.test(value)) {
      return '';
    }
    return value;
  }

  quoteTokens() {
    return this.config.quoteTokens || [];
  }

  denylist() {
    return new Set((this.config.denylist || []).map(address => String(address || '').toLowerCase()));
  }

  filterSummary() {
    return [
      `denylist=${this.denylist().size}`,
      `skipObservedPools=${this.config.skipObservedPools ? 1 : 0}`,
      `skipErc20Like=${this.config.skipErc20LikeTargets ? 1 : 0}`
    ].join(',');
  }

  minValueUsd() {
    return Number(this.config.minValueUsd || this.chainConfig.scan?.audit?.minLiquidityUsd || 40000);
  }

  priority() {
    return Number(this.config.priority || this.chainConfig.scan?.audit?.priority || 100);
  }

  getCodeWithTimeout(targetAddress) {
    return this.withTimeout(this.web3.eth.getCode(targetAddress), `getCode ${targetAddress}`);
  }

  getBalanceWithTimeout(targetAddress) {
    return this.withTimeout(this.web3.eth.getBalance(targetAddress), `getBalance ${targetAddress}`);
  }

  callWithTimeout(call, label) {
    return this.withTimeout(this.web3.eth.call(call), label);
  }

  withTimeout(promise, label) {
    const timeoutMs = Math.max(1000, Number(this.config.rpcTimeoutMs || 10000));
    let timer = null;
    return Promise.race([
      promise.finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'rpc'} timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  }

  async mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  shouldAttemptAudit(targetAddress) {
    const cooldownMs = Math.max(0, Number(this.config.cooldownMs || 24 * 60 * 60 * 1000));
    const now = Date.now();
    const last = this.lastAuditAttemptAt.get(targetAddress) || 0;
    if (cooldownMs > 0 && now - last < cooldownMs) {
      return false;
    }

    this.lastAuditAttemptAt.set(targetAddress, now);
    return true;
  }

  parseAddress(value) {
    const hex = String(value || '').replace(/^0x/i, '').padStart(64, '0');
    if (!hex || /^0+$/.test(hex)) {
      return '';
    }

    const address = `0x${hex.slice(-40)}`.toLowerCase();
    return this.web3.utils.isAddress(address) ? address : '';
  }

  toDecimal(value, decimals) {
    const raw = typeof value === 'bigint' ? value : BigInt(value || 0);
    const precision = Math.max(0, Number(decimals || 18));
    const negative = raw < 0n;
    const rawString = (negative ? -raw : raw).toString();

    if (precision === 0) {
      const result = Number(rawString);
      return negative ? -result : result;
    }

    const padded = rawString.padStart(precision + 1, '0');
    const integerPart = padded.slice(0, -precision);
    const fractionalPart = padded.slice(-precision).replace(/0+$/, '');
    if (integerPart.length > 308) {
      return negative ? -Infinity : Infinity;
    }

    const decimalString = fractionalPart ? `${integerPart}.${fractionalPart.slice(0, 18)}` : integerPart;
    const result = Number(decimalString);
    return negative ? -result : result;
  }

  formatUsd(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : 'n/a';
  }

  formatAssets(assets) {
    return (assets || [])
      .filter(asset => Number(asset.valueUsd || 0) > 0)
      .map(asset => `${asset.symbol}:${this.formatUsd(asset.valueUsd)}`)
      .join(',') || 'none';
  }
}

module.exports = MethodCallDiscovery;
