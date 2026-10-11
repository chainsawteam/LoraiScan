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

class ContractValueMonitor {
  constructor(web3, repository, chainConfig) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.config = chainConfig.scan?.contractValueMonitor || {};
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.processing = false;
    this.activeBlocks = 0;
    this.blockQueue = [];
    this.blockQueueKeys = new Set();
    this.lastObservedAt = new Map();
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
      throw new Error(`[${this.chainConfig.key}] contract-value subscription 已启用但缺少 web3 client`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    this.subscription = this.web3.eth.subscribe('newBlockHeaders');
    this.subscription
      .on('connected', id => {
        console.log(
          `[${this.chainConfig.key}] contract-value subscription connected id=${id} observeOnly=${this.triggerScan() ? 'false' : 'true'} minTotalUsd=${this.minTotalUsd()} filters=${this.filterSummary()} assets=${this.assetSummary()}`
        );
      })
      .on('data', header => {
        this.enqueueBlock(header.number, options);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] contract-value subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] contract-value subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] contract-value subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.max(1000, Number(this.chainConfig.scan?.discovery?.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] contract-value subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);
    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] contract-value subscription reconnect failed: ${reconnectError.message}`);
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
      console.error(`[${this.chainConfig.key}] contract-value queue 已满，丢弃最旧区块 block=${dropped.blockNumber}`);
    }

    this.blockQueue.push({ key, blockNumber, options });
    this.blockQueueKeys.add(key);
    this.drainBlockQueue().catch(error => {
      console.error(`[${this.chainConfig.key}] contract-value queue 处理失败: ${error.message}`);
    });
  }

  async drainBlockQueue() {
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
            console.error(`[${this.chainConfig.key}] contract-value block=${item.blockNumber || 'n/a'} 处理失败: ${error.message}`);
          })
          .finally(() => {
            this.activeBlocks -= 1;
            this.drainBlockQueue().catch(error => {
              console.error(`[${this.chainConfig.key}] contract-value queue 处理失败: ${error.message}`);
            });
          });
      }
    } finally {
      this.processing = false;
    }
  }

  async processBlock(blockNumber, options = {}) {
    const block = await this.getRawBlock(blockNumber);
    const txs = Array.isArray(block?.transactions) ? block.transactions : [];
    const maxTxs = Math.max(1, Number(this.config.maxTransactionsPerBlock || 5000));
    const maxContracts = Math.max(1, Number(this.config.maxContractsPerBlock || 500));
    const candidates = new Map();
    let contractCallTxs = 0;

    for (const tx of txs.slice(0, maxTxs)) {
      const to = String(tx.to || '').toLowerCase();
      const input = String(tx.input || '0x');
      if (!this.web3.utils.isAddress(to) || input === '0x' || input.length < 10) {
        continue;
      }

      contractCallTxs += 1;
      if (!candidates.has(to)) {
        candidates.set(to, tx);
      }
      if (candidates.size >= maxContracts) {
        break;
      }
    }

    let qualified = 0;
    let observed = 0;
    let failed = 0;
    let observedThisBlock = 0;
    const maxObservedPerBlock = Math.max(0, Number(this.config.maxObservedPerBlock || 0));
    const skipped = {
      denylist: 0,
      observedPool: 0,
      erc20Like: 0,
      assetStructure: 0
    };
    const concurrency = Math.max(1, Number(this.config.maxConcurrentContracts || 10));
    const entries = await this.filterCandidates(Array.from(candidates.entries()), skipped);

    for (let i = 0; i < entries.length; i += concurrency) {
      const results = await Promise.all(entries.slice(i, i + concurrency).map(([targetAddress, tx]) => (
        this.processCandidate(blockNumber, targetAddress, tx, options)
      )));
      for (const result of results) {
        qualified += result.qualified ? 1 : 0;
        if (result.observed) {
          if (maxObservedPerBlock === 0 || observedThisBlock < maxObservedPerBlock) {
            await this.observeQualifiedTarget(result.targetAddress, result.tx, result.valuation, result.qualification, options);
            observed += 1;
            observedThisBlock += 1;
          }
        }
        failed += result.failed ? 1 : 0;
        if (result.skippedReason && skipped[result.skippedReason] !== undefined) {
          skipped[result.skippedReason] += 1;
        }
      }
    }

    if (this.config.logEveryBlock || qualified > 0 || candidates.size >= maxContracts || failed > 0) {
      const capped = maxObservedPerBlock > 0 && qualified > observed ? ' capped=1' : '';
      console.log(
        `[${this.chainConfig.key}] contract-value block=${blockNumber} txs=${txs.length} checkedTxs=${Math.min(txs.length, maxTxs)} contractCallTxs=${contractCallTxs} uniqueTargets=${candidates.size} filteredTargets=${entries.length} qualified=${qualified} observed=${observed} failed=${failed} skippedDenylist=${skipped.denylist} skippedPool=${skipped.observedPool} skippedErc20=${skipped.erc20Like} skippedStructure=${skipped.assetStructure}${candidates.size >= maxContracts ? ' limited=1' : ''}${capped}`
      );
    }
  }

  async filterCandidates(entries, skipped) {
    let filtered = entries.filter(([targetAddress]) => {
      if (this.denylist().has(targetAddress)) {
        skipped.denylist += 1;
        return false;
      }
      return true;
    });

    if (this.config.skipObservedPools && this.repository?.getObservedPoolsByAddresses && filtered.length > 0) {
      const poolMap = await this.repository.getObservedPoolsByAddresses(
        this.chainConfig,
        filtered.map(([address]) => address)
      );
      filtered = filtered.filter(([targetAddress]) => {
        if (poolMap.has(targetAddress)) {
          skipped.observedPool += 1;
          return false;
        }
        return true;
      });
    }

    if (!this.config.skipErc20LikeTargets || filtered.length === 0) {
      return filtered;
    }

    const concurrency = Math.max(1, Number(this.config.maxConcurrentContracts || 10));
    const result = [];
    for (let i = 0; i < filtered.length; i += concurrency) {
      const chunk = filtered.slice(i, i + concurrency);
      const flags = await Promise.all(chunk.map(([targetAddress]) => this.isErc20Like(targetAddress)));
      for (let j = 0; j < chunk.length; j++) {
        if (flags[j]) {
          skipped.erc20Like += 1;
        } else {
          result.push(chunk[j]);
        }
      }
    }

    return result;
  }

  async processCandidate(blockNumber, targetAddress, tx, options = {}) {
    try {
      const valuation = await this.valueContract(targetAddress);
      const qualification = this.qualify(valuation);
      if (!qualification.qualified) {
        return {
          qualified: false,
          observed: false,
          failed: false,
          skippedReason: qualification.skippedReason || ''
        };
      }

      if (!this.shouldObserve(targetAddress)) {
        return { qualified: true, observed: false, failed: false };
      }

      return { qualified: true, observed: true, failed: false, targetAddress, tx, valuation, qualification };
    } catch (error) {
      console.error(`[${this.chainConfig.key}] contract-value target=${targetAddress} 估值失败 block=${blockNumber} err=${error.message}`);
      return { qualified: false, observed: false, failed: true };
    }
  }

  async observeQualifiedTarget(targetAddress, tx, valuation, qualification, options = {}) {
    const message = `[${this.chainConfig.key}] contract-value OBSERVE target=${targetAddress} tx=${tx.hash || 'n/a'} valueUsd=${this.formatUsd(valuation.totalUsd)} reasons=${qualification.reasons.join('|')} assets=${this.formatAssets(valuation.assets)}`;
    if (!this.triggerScan() || options.dryRun) {
      console.log(message);
      return;
    }

    try {
      const result = await this.auditClient.ensureAudit(this.chainConfig, targetAddress, {
        priority: this.priority(),
        context: {
          source: 'contract-value-monitor',
          txHash: tx.hash || ''
        }
      });
      console.log(`${message} LORAI ${result.skipped ? `跳过 reason=${result.reason}` : `已触发 run_id=${result.runId || 'n/a'}`}`);
    } catch (error) {
      console.error(`[${this.chainConfig.key}] contract-value target=${targetAddress} LORAI 触发失败 err=${error.message}`);
    }
  }

  async valueContract(targetAddress) {
    const assets = [];
    let totalUsd = 0;
    const nativePriceUsd = await this.nativePriceUsd();
    const native = this.config.nativeAsset || {};
    const nativeBalanceRaw = await this.web3.eth.getBalance(targetAddress);
    const nativeAmount = this.toDecimal(nativeBalanceRaw, native.decimals || 18);
    if (nativeAmount > 0) {
      const valueUsd = nativeAmount * nativePriceUsd;
      assets.push({
        symbol: native.symbol || 'NATIVE',
        amount: nativeAmount,
        priceUsd: nativePriceUsd,
        valueUsd,
        minAmount: Number(native.minAmount || 0),
        minValueUsd: Number(native.minValueUsd || 0)
      });
      totalUsd += valueUsd;
    }

    for (const token of this.coreAssets()) {
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
        valueUsd,
        minAmount: Number(token.minAmount || 0),
        minValueUsd: Number(token.minValueUsd || 0)
      });
      totalUsd += valueUsd;
    }

    return { totalUsd, assets };
  }

  qualify(valuation) {
    const reasons = [];
    const assets = valuation.assets || [];
    const heldAssetCount = assets.filter(asset => Number(asset.valueUsd || 0) > 0).length;
    const comboMinAssetCount = this.comboMinAssetCount();
    const comboMinTotalUsd = this.comboMinTotalUsd();
    const singleMinValueUsd = this.singleMinValueUsd();

    if (
      comboMinAssetCount > 0
      && comboMinTotalUsd > 0
      && heldAssetCount >= comboMinAssetCount
      && Number.isFinite(valuation.totalUsd)
      && valuation.totalUsd >= comboMinTotalUsd
    ) {
      reasons.push(`combo_assets>=${comboMinAssetCount}`);
      reasons.push(`combo_total_usd>=${comboMinTotalUsd}`);
    }

    for (const asset of assets) {
      if (singleMinValueUsd > 0 && asset.valueUsd >= singleMinValueUsd) {
        reasons.push(`${asset.symbol}_single_usd>=${singleMinValueUsd}`);
      }
      if (asset.minAmount > 0 && asset.amount >= asset.minAmount) {
        reasons.push(`${asset.symbol}_amount>=${asset.minAmount}`);
      }
      if (asset.minValueUsd > 0 && asset.valueUsd >= asset.minValueUsd) {
        reasons.push(`${asset.symbol}_usd>=${asset.minValueUsd}`);
      }
    }

    if (reasons.length === 0) {
      return {
        qualified: false,
        reasons: [],
        skippedReason: 'assetStructure'
      };
    }

    return {
      qualified: true,
      reasons,
      skippedReason: ''
    };
  }

  async getRawBlock(blockNumber) {
    const blockTag = typeof blockNumber === 'string' && blockNumber.startsWith('0x')
      ? blockNumber
      : `0x${Number(blockNumber).toString(16)}`;
    const payload = await this.rpcCall('eth_getBlockByNumber', [blockTag, true]);
    return {
      ...payload,
      transactions: (payload?.transactions || []).map(tx => ({
        hash: tx.hash,
        to: tx.to,
        input: tx.input || tx.data || '0x'
      }))
    };
  }

  rpcCall(method, params) {
    return new Promise((resolve, reject) => {
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
    });
  }

  async balanceOf(tokenAddress, holderAddress) {
    const data = this.web3.eth.abi.encodeFunctionCall(ERC20_BALANCE_OF, [holderAddress]);
    const result = await this.web3.eth.call({ to: tokenAddress, data });
    return BigInt(result || '0x0');
  }

  async isErc20Like(targetAddress) {
    if (this.erc20LikeCache.has(targetAddress)) {
      return this.erc20LikeCache.get(targetAddress);
    }

    let result = false;
    try {
      const [totalSupplyRaw, decimalsRaw, symbolRaw] = await Promise.all([
        this.web3.eth.call({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_TOTAL_SUPPLY, []) }),
        this.web3.eth.call({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_DECIMALS, []) }),
        this.web3.eth.call({ to: targetAddress, data: this.web3.eth.abi.encodeFunctionCall(ERC20_SYMBOL, []) })
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
      console.warn(`[${this.chainConfig.key}] contract-value native price 查询失败，使用 fallback=${price}: ${error.message}`);
    }

    this.nativePriceCache = {
      value: Number.isFinite(price) ? price : 0,
      expiresAt: now + Math.max(1000, Number(this.config.nativeAsset?.priceTtlMs || 5 * 60 * 1000))
    };
    return this.nativePriceCache.value;
  }

  async fetchNativePriceFromPair() {
    const native = this.config.nativeAsset || {};
    const wrappedNative = String(native.wrappedAddress || '').toLowerCase();
    const stable = String(native.priceTokenAddress || '').toLowerCase();
    const factory = String(native.priceFactoryAddress || '').toLowerCase();
    const stableDecimals = Number(native.priceTokenDecimals || 18);
    if (!wrappedNative || !stable || !factory) {
      return Number(native.fallbackPriceUsd || 0);
    }

    const getPairData = this.web3.eth.abi.encodeFunctionCall(FACTORY_GET_PAIR, [wrappedNative, stable]);
    const pairRaw = await this.web3.eth.call({ to: factory, data: getPairData });
    const pair = this.parseAddress(pairRaw);
    if (!pair) {
      return Number(native.fallbackPriceUsd || 0);
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
    const nativeAmount = this.toDecimal(nativeReserve, native.decimals || 18);
    const stableAmount = this.toDecimal(stableReserve, stableDecimals);
    return nativeAmount > 0 ? stableAmount / nativeAmount : Number(native.fallbackPriceUsd || 0);
  }

  shouldObserve(targetAddress) {
    const cooldownMs = Math.max(0, Number(this.config.cooldownMs || 0));
    if (cooldownMs === 0) {
      return true;
    }

    const now = Date.now();
    const last = this.lastObservedAt.get(targetAddress) || 0;
    if (now - last < cooldownMs) {
      return false;
    }

    this.lastObservedAt.set(targetAddress, now);
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

  coreAssets() {
    return this.config.coreAssets || [];
  }

  minTotalUsd() {
    return Number(this.config.minTotalUsd || 0);
  }

  comboMinTotalUsd() {
    return Number(this.config.comboMinTotalUsd || this.config.minTotalUsd || 0);
  }

  comboMinAssetCount() {
    return Math.max(0, Number(this.config.comboMinAssetCount || 0));
  }

  singleMinValueUsd() {
    return Number(this.config.singleMinValueUsd || 0);
  }

  triggerScan() {
    return Boolean(this.config.triggerScan);
  }

  priority() {
    return Number(this.config.priority || this.chainConfig.scan?.audit?.priority || 100);
  }

  assetSummary() {
    const native = this.config.nativeAsset || {};
    const nativeSummary = native.symbol
      ? `${native.symbol}:amount>=${native.minAmount || 0},usd>=${native.minValueUsd || 0}`
      : '';
    const tokenSummary = this.coreAssets()
      .map(asset => `${asset.symbol}:amount>=${asset.minAmount || 0},usd>=${asset.minValueUsd || 0}`)
      .join(',');
    return [nativeSummary, tokenSummary].filter(Boolean).join(',');
  }

  denylist() {
    return new Set((this.config.denylist || []).map(address => String(address || '').toLowerCase()));
  }

  filterSummary() {
    return [
      `denylist=${this.denylist().size}`,
      `skipObservedPools=${this.config.skipObservedPools ? 1 : 0}`,
      `skipErc20Like=${this.config.skipErc20LikeTargets ? 1 : 0}`,
      `comboAssets=${this.comboMinAssetCount()}`,
      `comboUsd=${this.comboMinTotalUsd()}`,
      `singleUsd=${this.singleMinValueUsd()}`
    ].join(',');
  }

  formatUsd(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : 'n/a';
  }

  formatAssets(assets) {
    return (assets || [])
      .filter(asset => Number(asset.valueUsd || 0) > 0)
      .map(asset => `${asset.symbol}:amount=${Number(asset.amount || 0).toFixed(6)},usd=${this.formatUsd(asset.valueUsd)}`)
      .join(',') || 'none';
  }
}

module.exports = ContractValueMonitor;
