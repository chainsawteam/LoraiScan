const TokenBytecodeFilter = require('../lib/tokenBytecodeFilter');
const LoraiAuditClient = require('../lib/loraiAuditClient');
const FactoryLiquidityResolver = require('../lib/factoryLiquidityResolver');
const { DEFAULT_QUOTE_TOKENS } = require('../lib/poolLiquidityCalibrator');

const mintTopics = {
  'uniswap-v2': '0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f',
  'uniswap-v3': '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
};

class LiquidityEventDiscovery {
  constructor(web3, repository, chainConfig, discoveryConfig = null) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.discoveryConfig = discoveryConfig;
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.recentBackfillRunning = false;
    this.bytecodeFilter = new TokenBytecodeFilter(web3, chainConfig);
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.quoteTokens = {
      ...(DEFAULT_QUOTE_TOKENS[chainConfig.key] || {}),
      ...(chainConfig.scan?.calibration?.quoteTokens || {})
    };
    this.priceResolver = new FactoryLiquidityResolver(web3, chainConfig, this.quoteTokens);
    if (!LiquidityEventDiscovery.auditEventCache) {
      LiquidityEventDiscovery.auditEventCache = new Map();
    }
  }

  async discover(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const rememberState = Boolean(options.rememberState);
    const config = this.discoveryConfig || {};
    if (!config.enabled) {
      return 0;
    }
    if (config.backfillEnabled === false && !options.force) {
      const protocol = config.protocol || 'uniswap-v2';
      const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
      console.log(`[${this.chainConfig.key}] liquidity=${sourceKey} backfill disabled; subscription-only`);
      return 0;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] liquidity discovery 已启用但缺少 web3 client`);
    }

    const protocol = config.protocol || 'uniswap-v2';
    const topic = mintTopics[protocol];
    if (!topic) {
      throw new Error(`[${this.chainConfig.key}] liquidity discovery 不支持协议: ${protocol}`);
    }

    const latestBlock = Number(await this.web3.eth.getBlockNumber());
    const toBlock = Math.max(0, latestBlock - (options.confirmations ?? config.confirmations ?? 0));
    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const stateKey = options.stateKey || `${options.stateKeyPrefix || ''}liquidity:${sourceKey}`;
    const state = await this.repository.getScannerState(this.chainConfig, stateKey);
    const startBlock = this.resolveStartBlock(config.fromBlock, toBlock);
    let fromBlock = state?.last_block === undefined || state?.last_block === null
      ? startBlock
      : Number(state.last_block) + 1;
    if ((state?.last_block === undefined || state?.last_block === null) && Number(options.initialBackfillBlocks || 0) > 0) {
      const recentStartBlock = Math.max(0, toBlock - Number(options.initialBackfillBlocks) + 1);
      fromBlock = fromBlock >= toBlock ? recentStartBlock : Math.max(fromBlock, recentStartBlock);
    }

    if (fromBlock > toBlock) {
      console.log(`[${this.chainConfig.key}] liquidity=${sourceKey} 无新区块 from=${fromBlock} to=${toBlock}`);
      return 0;
    }

    const batchBlocks = Math.max(1, Number(options.batchBlocks || config.batchBlocks || 2000));
    const ignoreTokens = new Set((config.ignoreTokens || []).map(token => token.toLowerCase()));
    const scanDelayMs = Number(config.liquidityScanDelayMs || config.scanDelayMs || 15 * 60 * 1000);
    let enqueued = 0;

    while (fromBlock <= toBlock) {
      const batchToBlock = Math.min(toBlock, fromBlock + batchBlocks - 1);
      const logs = await this.web3.eth.getPastLogs({
        fromBlock,
        toBlock: batchToBlock,
        topics: [topic]
      });
      const poolMap = await this.repository.getObservedPoolsByAddresses(
        this.chainConfig,
        logs.map(log => log.address)
      );
      let matched = 0;

      for (const log of logs) {
        const pool = await this.resolvePoolForMintLog(log, poolMap, {
          dryRun,
          sourceKey,
          protocol,
          label: 'poll'
        });
        if (!pool) {
          continue;
        }

        matched += 1;
        enqueued += await this.processMatchedLog(log, pool, {
          dryRun,
          sourceKey,
          protocol,
          ignoreTokens,
          scanDelayMs,
          onTokenDiscovered: options.onTokenDiscovered
        }, 'poll');
      }

      if (!dryRun || rememberState) {
        await this.repository.upsertScannerState(this.chainConfig, stateKey, batchToBlock, {
          protocol,
          sourceKey,
          logs: logs.length,
          matched,
          enqueued,
          scanDelayMs
        });
      }

      console.log(
        `[${this.chainConfig.key}] liquidity=${sourceKey} protocol=${protocol}${dryRun ? ' [dry-run]' : ''} blocks=${fromBlock}-${batchToBlock} logs=${logs.length} matched=${matched} enqueued=${enqueued}`
      );

      fromBlock = batchToBlock + 1;
    }

    return enqueued;
  }

  startSubscription(options = {}) {
    const config = this.discoveryConfig || {};
    if (!config.enabled || !config.subscribeEnabled) {
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] liquidity subscription 已启用但缺少 web3 client`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const config = this.discoveryConfig || {};
    const protocol = config.protocol || 'uniswap-v2';
    const topic = mintTopics[protocol];
    if (!topic) {
      throw new Error(`[${this.chainConfig.key}] liquidity subscription 不支持协议: ${protocol}`);
    }

    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const ignoreTokens = new Set((config.ignoreTokens || []).map(token => token.toLowerCase()));
    const scanDelayMs = Number(config.liquidityScanDelayMs || config.scanDelayMs || 15 * 60 * 1000);
    this.subscription = this.web3.eth.subscribe('logs', {
      topics: [topic]
    });

    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription connected id=${id}`);
        this.backfillRecentBlocks({
          dryRun,
          sourceKey,
          protocol,
          topic,
          ignoreTokens,
          scanDelayMs,
          onTokenDiscovered: options.onTokenDiscovered
        }).catch(error => {
          console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} recent-backfill 失败: ${error.message}`);
        });
      })
      .on('data', log => {
        this.handleSubscriptionLog(log, {
          dryRun,
          sourceKey,
          protocol,
          ignoreTokens,
          scanDelayMs,
          onTokenDiscovered: options.onTokenDiscovered
        }).catch(error => {
          console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription 处理失败: ${error.message}`);
        });
      })
      .on('changed', log => {
        console.log(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription removed block=${Number(log.blockNumber)} pool=${log.address || 'n/a'} tx=${log.transactionHash || 'n/a'} logIndex=${Number(log.logIndex)}`);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const config = this.discoveryConfig || {};
    const protocol = config.protocol || 'uniswap-v2';
    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const delayMs = Math.max(1000, Number(config.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);

    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.subscription = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] liquidity=${sourceKey} subscription reconnect failed: ${reconnectError.message}`);
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
      // Best effort cleanup; reconnect will create a fresh subscription.
    }
  }

  async backfillRecentBlocks(options) {
    const config = this.discoveryConfig || {};
    const recentBlocks = Math.max(0, Number(
      config.subscriptionBackfillBlocks
      || config.reconnectBackfillBlocks
      || config.recentBackfillBlocks
      || 64
    ));
    if (recentBlocks === 0 || this.recentBackfillRunning) {
      return 0;
    }

    this.recentBackfillRunning = true;
    try {
      const latestBlock = Number(await this.web3.eth.getBlockNumber());
      const toBlock = Math.max(0, latestBlock - Number(config.confirmations || 0));
      const fromBlock = Math.max(0, toBlock - recentBlocks + 1);
      if (fromBlock > toBlock) {
        return 0;
      }

      const logs = await this.web3.eth.getPastLogs({
        fromBlock,
        toBlock,
        topics: [options.topic]
      });
      if (logs.length === 0) {
        console.log(`[${this.chainConfig.key}] liquidity=${options.sourceKey} recent-backfill blocks=${fromBlock}-${toBlock} logs=0 matched=0 enqueued=0`);
        return 0;
      }

      const poolMap = await this.repository.getObservedPoolsByAddresses(
        this.chainConfig,
        logs.map(log => log.address)
      );
      let matched = 0;
      let enqueued = 0;

      for (const log of logs) {
        const pool = await this.resolvePoolForMintLog(log, poolMap, options);
        if (!pool) {
          continue;
        }

        matched += 1;
        enqueued += await this.processMatchedLog(log, pool, options, 'recent-backfill');
      }

      console.log(`[${this.chainConfig.key}] liquidity=${options.sourceKey} recent-backfill blocks=${fromBlock}-${toBlock} logs=${logs.length} matched=${matched} enqueued=${enqueued}`);
      return enqueued;
    } finally {
      this.recentBackfillRunning = false;
    }
  }

  async handleSubscriptionLog(log, options) {
    if (log?.removed) {
      return;
    }

    const poolAddress = String(log.address || '').toLowerCase();
    const poolMap = await this.repository.getObservedPoolsByAddresses(this.chainConfig, [poolAddress]);
    const pool = await this.resolvePoolForMintLog(log, poolMap, options);
    if (!pool) {
      return;
    }

    await this.processMatchedLog(log, pool, options, 'subscribe');
  }

  async resolvePoolForMintLog(log, poolMap, options = {}) {
    const poolAddress = String(log?.address || '').toLowerCase();
    if (!poolAddress) {
      return null;
    }

    const knownPool = poolMap.get(poolAddress);
    if (knownPool) {
      if (!this.poolBelongsToSource(knownPool, options)) {
        return null;
      }
      return knownPool;
    }

    const config = this.discoveryConfig || {};
    const protocol = options.protocol || config.protocol || 'uniswap-v2';
    const sourceKey = options.sourceKey || config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const resolved = await this.resolvePoolTokens(poolAddress);
    if (!resolved) {
      console.warn(
        `[${this.chainConfig.key}] liquidity=${sourceKey} [${options.label || 'subscribe'}] Mint 未知池子且无法读取 token0/token1 pool=${poolAddress} tx=${log.transactionHash || 'n/a'}`
      );
      return null;
    }

    const configuredFactory = String(config.factoryAddress || '').toLowerCase();
    if (configuredFactory && resolved.factoryAddress && resolved.factoryAddress !== configuredFactory) {
      return null;
    }

    const pool = {
      sourceKey,
      protocol,
      factoryAddress: resolved.factoryAddress || config.factoryAddress || '',
      poolAddress,
      token0: resolved.token0,
      token1: resolved.token1,
      createdBlock: null
    };

    if (!options.dryRun || this.repository.dryRunMemoryState) {
      try {
        await this.repository.upsertObservedPools(this.chainConfig, [pool]);
      } catch (error) {
        console.error(
          `[${this.chainConfig.key}] liquidity=${sourceKey} Mint 动态登记池子失败 pool=${poolAddress} tx=${log.transactionHash || 'n/a'} err=${error.message}`
        );
        return null;
      }
    }

    const hydratedPool = {
      chain_name: this.chainConfig.key,
      chain_id: this.chainConfig.chainId,
      source_key: sourceKey,
      protocol,
      factory_address: String(resolved.factoryAddress || config.factoryAddress || '').toLowerCase(),
      pool_address: poolAddress,
      token0_address: resolved.token0,
      token1_address: resolved.token1,
      created_block: null
    };
    if (poolMap) {
      poolMap.set(poolAddress, hydratedPool);
    }
    console.log(
      `[${this.chainConfig.key}] liquidity=${sourceKey} [${options.label || 'subscribe'}] Mint 动态发现池子 pool=${poolAddress} token0=${resolved.token0} token1=${resolved.token1} tx=${log.transactionHash || 'n/a'}`
    );
    return hydratedPool;
  }

  async resolvePoolTokens(poolAddress) {
    if (!this.web3 || !/^0x[a-f0-9]{40}$/.test(poolAddress)) {
      return null;
    }

    try {
      const [token0Result, token1Result] = await Promise.all([
        this.web3.eth.call({ to: poolAddress, data: '0x0dfe1681' }),
        this.web3.eth.call({ to: poolAddress, data: '0xd21220a7' })
      ]);
      const token0 = this.decodeAddressResult(token0Result);
      const token1 = this.decodeAddressResult(token1Result);
      if (!token0 || !token1 || token0 === token1) {
        return null;
      }
      return {
        token0,
        token1,
        factoryAddress: await this.resolvePoolFactory(poolAddress)
      };
    } catch (error) {
      console.warn(`[${this.chainConfig.key}] Mint 动态读取池子 token0/token1 失败 pool=${poolAddress} err=${error.message}`);
      return null;
    }
  }

  async resolvePoolFactory(poolAddress) {
    try {
      return this.decodeAddressResult(await this.web3.eth.call({ to: poolAddress, data: '0xc45a0155' }));
    } catch (_) {
      return '';
    }
  }

  poolBelongsToSource(pool, options = {}) {
    const expectedSourceKey = String(options.sourceKey || '').toLowerCase();
    const actualSourceKey = String(pool.source_key || '').toLowerCase();
    if (expectedSourceKey && actualSourceKey && expectedSourceKey !== actualSourceKey) {
      return false;
    }

    const expectedProtocol = String(options.protocol || '').toLowerCase();
    const actualProtocol = String(pool.protocol || '').toLowerCase();
    if (expectedProtocol && actualProtocol && expectedProtocol !== actualProtocol) {
      return false;
    }

    return true;
  }

  decodeAddressResult(value) {
    const normalized = String(value || '').replace(/^0x/, '').padStart(64, '0');
    if (normalized.length < 64 || !/^0{24}[a-f0-9]{40}$/i.test(normalized.slice(-64))) {
      return null;
    }
    return `0x${normalized.slice(-40)}`.toLowerCase();
  }

  async processMatchedLog(log, pool, options, label) {
    const tokenAddresses = [pool.token0_address, pool.token1_address]
      .map(token => String(token || '').toLowerCase())
      .filter(token => token && !options.ignoreTokens.has(token));
    const filterResult = await this.bytecodeFilter.filterTokenAddresses(tokenAddresses, {
      sourceKey: options.sourceKey,
      protocol: options.protocol,
      pool: pool.pool_address,
      block: Number(log.blockNumber),
      tx: log.transactionHash || '',
      label
    });
    const directAudit = await this.maybeTriggerAuditFromEventLiquidity(log, pool, filterResult.allowed, options, label);

    if (!options.dryRun) {
      await this.repository.markObservedPoolLiquidity(this.chainConfig, pool.pool_address, Number(log.blockNumber));
      if (filterResult.skipped.length > 0) {
        await this.repository.disableScanTokensBatch(
          this.chainConfig,
          filterResult.skipped.map(item => item.tokenAddress),
          filterResult.skipped.map(item => item.reason).join(',')
        );
      }
      if (filterResult.allowed.length === 0) {
        console.log(
          `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}] matched pool=${pool.pool_address} block=${Number(log.blockNumber)} tokens=all_filtered enqueued=0 delayMs=${options.scanDelayMs}`
        );
        return 0;
      }
      const seedTokens = filterResult.allowed.filter(token => !directAudit.handledTokens.has(String(token || '').toLowerCase()));
      if (seedTokens.length === 0) {
        console.log(
          `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}] matched pool=${pool.pool_address} block=${Number(log.blockNumber)} tokens=${filterResult.allowed.join(',')} eventAuditHandled=${directAudit.handledTokens.size} enqueued=0 delayMs=${options.scanDelayMs}`
        );
        return 0;
      }
      const inserted = await this.repository.seedScanTokens(this.chainConfig, seedTokens, `liquidity:${options.sourceKey}`, {
        delayMs: options.scanDelayMs,
        reschedule: true
      });
      console.log(
        `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}] matched pool=${pool.pool_address} block=${Number(log.blockNumber)} tokens=${filterResult.allowed.join(',')} eventAuditHandled=${directAudit.handledTokens.size} enqueued=${inserted} delayMs=${options.scanDelayMs}`
      );
      return inserted;
    }

    if (filterResult.allowed.length === 0) {
      console.log(
        `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}][dry-run] matched pool=${pool.pool_address} block=${Number(log.blockNumber)} tokens=all_filtered`
      );
      return 0;
    }

    console.log(
      `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}][dry-run] matched pool=${pool.pool_address} block=${Number(log.blockNumber)} tokens=${filterResult.allowed.join(',')}`
    );
    if (options.onTokenDiscovered) {
      await options.onTokenDiscovered({
        tokenAddresses: filterResult.allowed,
        pool,
        log,
        sourceKey: options.sourceKey,
        protocol: options.protocol
      });
    }
    return filterResult.allowed.length;
  }

  async maybeTriggerAuditFromEventLiquidity(log, pool, tokenAddresses, options, label) {
    const handledTokens = new Set();
    const auditConfig = this.chainConfig.scan?.audit || {};
    if (!auditConfig.enabled || !Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      return { handledTokens };
    }

    const eventLiquidity = await this.resolveEventLiquidityUsd(log, pool, options.protocol);
    if (!eventLiquidity || !Number.isFinite(eventLiquidity.liquidityUsd)) {
      return { handledTokens };
    }

    const thresholdUsd = Number(auditConfig.minLiquidityUsd || 10000);
    const tokenList = tokenAddresses
      .map(token => String(token || '').toLowerCase())
      .filter(token => token && !this.quoteTokens[token]);

    if (tokenList.length === 0) {
      return { handledTokens };
    }

    if (eventLiquidity.liquidityUsd <= thresholdUsd) {
      console.log(
        `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}] event-liquidity 跳过 liquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} threshold=${thresholdUsd} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'} quote=${eventLiquidity.quoteSymbol} amount=${eventLiquidity.quoteAmount}`
      );
      return { handledTokens };
    }

    if (options.dryRun) {
      console.log(
        `[${this.chainConfig.key}] liquidity=${options.sourceKey} [${label}][dry-run] event-liquidity would audit tokens=${tokenList.join(',')} liquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} threshold=${thresholdUsd} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'} quote=${eventLiquidity.quoteSymbol} amount=${eventLiquidity.quoteAmount}`
      );
      return { handledTokens };
    }

    for (const tokenAddress of tokenList) {
      if (this.hasRecentlyHandledAuditEvent(log, tokenAddress)) {
        handledTokens.add(tokenAddress);
        console.log(
          `[${this.chainConfig.key}] token=${tokenAddress} LORAI 跳过 reason=duplicate_event eventLiquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'}`
        );
        continue;
      }

      this.rememberAuditEvent(log, tokenAddress);
      try {
        const result = await this.auditClient.ensureAudit(this.chainConfig, tokenAddress, {
          priority: auditConfig.priority
        });
        if (result.skipped) {
          if (result.reason === 'existing_audit') {
            handledTokens.add(tokenAddress);
          }
          console.log(
            `[${this.chainConfig.key}] token=${tokenAddress} LORAI 跳过 reason=${result.reason} eventLiquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'}`
          );
          continue;
        }

        handledTokens.add(tokenAddress);
        console.log(
          `[${this.chainConfig.key}] token=${tokenAddress} LORAI 已触发 run_id=${result.runId || 'n/a'} eventLiquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'}`
        );
      } catch (error) {
        this.forgetAuditEvent(log, tokenAddress);
        console.error(
          `[${this.chainConfig.key}] token=${tokenAddress} LORAI 触发失败 eventLiquidityUsd=${this.formatUsd(eventLiquidity.liquidityUsd)} pool=${pool.pool_address} tx=${log.transactionHash || 'n/a'} err=${error.message}`
        );
      }
    }

    return { handledTokens };
  }

  hasRecentlyHandledAuditEvent(log, tokenAddress) {
    const key = this.auditEventKey(log, tokenAddress);
    if (!key) {
      return false;
    }
    this.pruneAuditEventCache();
    return LiquidityEventDiscovery.auditEventCache.has(key);
  }

  rememberAuditEvent(log, tokenAddress) {
    const key = this.auditEventKey(log, tokenAddress);
    if (!key) {
      return;
    }
    this.pruneAuditEventCache();
    LiquidityEventDiscovery.auditEventCache.set(key, Date.now());
  }

  forgetAuditEvent(log, tokenAddress) {
    const key = this.auditEventKey(log, tokenAddress);
    if (key) {
      LiquidityEventDiscovery.auditEventCache.delete(key);
    }
  }

  auditEventKey(log, tokenAddress) {
    const txHash = String(log?.transactionHash || '').toLowerCase();
    const logIndex = log?.logIndex === undefined || log?.logIndex === null ? 'unknown' : String(Number(log.logIndex));
    const token = String(tokenAddress || '').toLowerCase();
    if (!txHash || !token) {
      return '';
    }
    return `${this.chainConfig.chainId}:${txHash}:${logIndex}:${token}`;
  }

  pruneAuditEventCache() {
    const cache = LiquidityEventDiscovery.auditEventCache;
    const ttlMs = 60 * 60 * 1000;
    const now = Date.now();
    for (const [key, timestamp] of cache.entries()) {
      if (now - timestamp > ttlMs) {
        cache.delete(key);
      }
    }
  }

  async resolveEventLiquidityUsd(log, pool, protocol) {
    const amounts = this.decodeMintAmounts(log, protocol);
    if (!amounts) {
      return null;
    }

    const sides = [
      { index: 0, address: String(pool.token0_address || '').toLowerCase(), rawAmount: amounts.amount0 },
      { index: 1, address: String(pool.token1_address || '').toLowerCase(), rawAmount: amounts.amount1 }
    ].filter(side => side.address && this.quoteTokens[side.address] && side.rawAmount > 0n);

    if (sides.length === 0) {
      return null;
    }

    const quoteValues = [];
    for (const side of sides) {
      const quote = {
        address: side.address,
        meta: this.quoteTokens[side.address]
      };
      const priceUsd = await this.priceResolver.resolveQuotePriceUsd(quote);
      const amount = this.formatUnits(side.rawAmount, quote.meta.decimals || 18);
      const valueUsd = amount * priceUsd;
      if (Number.isFinite(valueUsd) && valueUsd > 0) {
        quoteValues.push({
          side,
          amount,
          priceUsd,
          valueUsd,
          symbol: quote.meta.symbol || side.address
        });
      }
    }

    if (quoteValues.length === 0) {
      return null;
    }

    const liquidityUsd = quoteValues.length > 1
      ? quoteValues.reduce((sum, item) => sum + item.valueUsd, 0)
      : quoteValues[0].valueUsd * 2;

    const primary = quoteValues.sort((a, b) => b.valueUsd - a.valueUsd)[0];
    return {
      liquidityUsd,
      quoteAmount: primary.amount,
      quoteSymbol: primary.symbol,
      quotePriceUsd: primary.priceUsd
    };
  }

  decodeMintAmounts(log, protocol) {
    try {
      if (protocol === 'uniswap-v2') {
        const decoded = this.web3.eth.abi.decodeParameters(['uint256', 'uint256'], log.data || '0x');
        return {
          amount0: BigInt(decoded[0] || 0),
          amount1: BigInt(decoded[1] || 0)
        };
      }

      if (protocol === 'uniswap-v3') {
        const decoded = this.web3.eth.abi.decodeParameters(['address', 'uint128', 'uint256', 'uint256'], log.data || '0x');
        return {
          amount0: BigInt(decoded[2] || 0),
          amount1: BigInt(decoded[3] || 0)
        };
      }
    } catch (error) {
      console.error(`[${this.chainConfig.key}] liquidity mint decode 失败 protocol=${protocol} pool=${log.address || 'n/a'} tx=${log.transactionHash || 'n/a'} err=${error.message}`);
    }

    return null;
  }

  formatUnits(rawValue, decimals) {
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

  formatUsd(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : 'n/a';
  }

  resolveStartBlock(fromBlock, toBlock) {
    if (fromBlock === 'latest' || fromBlock === 'now') {
      return toBlock;
    }

    return Number(fromBlock || 0);
  }
}

module.exports = LiquidityEventDiscovery;
