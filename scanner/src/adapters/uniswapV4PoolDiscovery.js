const TokenBytecodeFilter = require('../lib/tokenBytecodeFilter');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

class UniswapV4PoolDiscovery {
  constructor(web3, repository, chainConfig, discoveryConfig = null) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.discoveryConfig = discoveryConfig || {};
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.recentBackfillRunning = false;
    this.bytecodeFilter = new TokenBytecodeFilter(web3, chainConfig);
  }

  async discover(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const rememberState = Boolean(options.rememberState);
    const config = this.config();
    if (!config.enabled) {
      return 0;
    }
    if (!config.poolManagerAddress) {
      console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 缺少 poolManagerAddress，跳过`);
      return 0;
    }
    if (config.backfillEnabled === false && !options.force) {
      console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 backfill disabled; subscription-only`);
      return 0;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] v4 discovery 已启用但缺少 web3 client`);
    }

    const latestBlock = Number(await this.web3.eth.getBlockNumber());
    const toBlock = Math.max(0, latestBlock - (options.confirmations ?? config.confirmations ?? 0));
    const stateKey = options.stateKey || `${options.stateKeyPrefix || ''}v4:${config.sourceKey}`;
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
      console.log(`[${this.chainConfig.key}] discovery=${stateKey} 无新区块 from=${fromBlock} to=${toBlock}`);
      return 0;
    }

    const batchBlocks = Math.max(1, Number(options.batchBlocks || config.batchBlocks || 2000));
    let totalInitialized = 0;
    let totalActive = 0;
    let totalEnqueued = 0;

    while (fromBlock <= toBlock) {
      const batchToBlock = Math.min(toBlock, fromBlock + batchBlocks - 1);
      const initLogs = await this.web3.eth.getPastLogs({
        address: config.poolManagerAddress,
        fromBlock,
        toBlock: batchToBlock,
        topics: [this.initializeTopic()]
      });
      const activeLogs = await this.web3.eth.getPastLogs({
        address: config.poolManagerAddress,
        fromBlock,
        toBlock: batchToBlock,
        topics: [[this.modifyLiquidityTopic(), this.swapTopic()]]
      });

      const pools = this.logsToPools(initLogs, config);
      const insertedPools = dryRun && !this.repository.dryRunMemoryState
        ? 0
        : await this.persistPools(pools);
      const activeResult = await this.processActivityLogs(activeLogs, config, {
        dryRun,
        label: 'poll'
      });

      totalInitialized += pools.length;
      totalActive += activeResult.matched;
      totalEnqueued += activeResult.enqueued;

      if (!dryRun || rememberState) {
        await this.repository.upsertScannerState(this.chainConfig, stateKey, batchToBlock, {
          protocol: 'uniswap-v4',
          sourceKey: config.sourceKey,
          poolManagerAddress: config.poolManagerAddress,
          initLogs: initLogs.length,
          activeLogs: activeLogs.length,
          initialized: pools.length,
          insertedPools,
          activeMatched: activeResult.matched,
          enqueued: activeResult.enqueued
        });
      }

      console.log(
        `[${this.chainConfig.key}] discovery=${config.sourceKey} protocol=uniswap-v4${dryRun ? ' [dry-run]' : ''} blocks=${fromBlock}-${batchToBlock} initLogs=${initLogs.length} pools=${pools.length} activeLogs=${activeLogs.length} activeMatched=${activeResult.matched} enqueued=${activeResult.enqueued}`
      );

      fromBlock = batchToBlock + 1;
    }

    return totalInitialized + totalActive + totalEnqueued;
  }

  startSubscription(options = {}) {
    const config = this.config();
    if (!config.enabled || !config.subscribeEnabled) {
      return null;
    }
    if (!config.poolManagerAddress) {
      console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription 缺少 poolManagerAddress，跳过`);
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] v4 discovery subscription 已启用但缺少 web3 client`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const config = this.config();
    this.subscription = this.web3.eth.subscribe('logs', {
      address: config.poolManagerAddress,
      topics: [[this.initializeTopic(), this.modifyLiquidityTopic(), this.swapTopic()]]
    });

    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription connected id=${id} poolManager=${config.poolManagerAddress}`);
        this.backfillRecentBlocks({ dryRun }).catch(error => {
          console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 recent-backfill 失败: ${error.message}`);
        });
      })
      .on('data', log => {
        this.handleSubscriptionLog(log, { dryRun }).catch(error => {
          console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription 处理失败: ${error.message}`);
        });
      })
      .on('changed', log => {
        console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription removed block=${Number(log.blockNumber)} poolId=${String(log.topics?.[1] || '').toLowerCase()} tx=${log.transactionHash || 'n/a'} logIndex=${Number(log.logIndex)}`);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const config = this.config();
    const delayMs = Math.max(1000, Number(config.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);

    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.subscription = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 subscription reconnect failed: ${reconnectError.message}`);
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

  async backfillRecentBlocks(options = {}) {
    const config = this.config();
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
      const logs = await this.web3.eth.getPastLogs({
        address: config.poolManagerAddress,
        fromBlock,
        toBlock,
        topics: [[this.initializeTopic(), this.modifyLiquidityTopic(), this.swapTopic()]]
      });

      let initLogs = 0;
      let activeLogs = 0;
      let enqueued = 0;
      for (const log of logs) {
        const result = await this.handleLog(log, { dryRun: Boolean(options.dryRun), label: 'recent-backfill' });
        initLogs += result.initialized || 0;
        activeLogs += result.matched || 0;
        enqueued += result.enqueued || 0;
      }

      console.log(`[${this.chainConfig.key}] discovery=${config.sourceKey} v4 recent-backfill blocks=${fromBlock}-${toBlock} logs=${logs.length} initialized=${initLogs} activeMatched=${activeLogs} enqueued=${enqueued}`);
      return initLogs + activeLogs + enqueued;
    } finally {
      this.recentBackfillRunning = false;
    }
  }

  async handleSubscriptionLog(log, options = {}) {
    if (log?.removed) {
      return;
    }

    await this.handleLog(log, { dryRun: Boolean(options.dryRun), label: 'subscribe' });
  }

  async handleLog(log, options = {}) {
    const topic = String(log.topics?.[0] || '').toLowerCase();
    const config = this.config();
    if (topic === this.initializeTopic()) {
      const pools = this.logsToPools([log], config);
      if (pools.length === 0) {
        return { initialized: 0 };
      }

      if (!options.dryRun || this.repository.dryRunMemoryState) {
        await this.persistPools(pools);
      }
      for (const pool of pools) {
        console.log(
          `[${this.chainConfig.key}] discovery=${config.sourceKey} [${options.label}] new-v4-pool block=${pool.initializedBlock} poolId=${pool.poolId} token0=${pool.currency0} token1=${pool.currency1} fee=${pool.fee} tickSpacing=${pool.tickSpacing} hooks=${pool.hooksAddress} tx=${pool.txHash || 'n/a'}`
        );
      }
      return { initialized: pools.length };
    }

    if (topic === this.modifyLiquidityTopic() || topic === this.swapTopic()) {
      const result = await this.processActivityLogs([log], config, {
        dryRun: Boolean(options.dryRun),
        label: options.label
      });
      return {
        matched: result.matched,
        enqueued: result.enqueued
      };
    }

    return {};
  }

  logsToPools(logs, config) {
    const pools = [];
    for (const log of logs) {
      const pool = this.parseInitializeLog(log, config);
      if (!pool) {
        continue;
      }

      pools.push(pool);
    }

    return pools;
  }

  parseInitializeLog(log, config) {
    const poolId = String(log.topics?.[1] || '').toLowerCase();
    const currency0 = this.topicToAddress(log.topics?.[2]);
    const currency1 = this.topicToAddress(log.topics?.[3]);
    if (!this.isPoolId(poolId) || !currency0 || !currency1) {
      return null;
    }

    const decoded = this.web3.eth.abi.decodeParameters(
      ['uint24', 'int24', 'address', 'uint160', 'int24'],
      log.data || '0x'
    );
    return {
      sourceKey: config.sourceKey,
      protocol: 'uniswap-v4',
      poolManagerAddress: config.poolManagerAddress,
      poolId,
      poolAddress: poolId,
      currency0,
      currency1,
      token0: currency0,
      token1: currency1,
      fee: Number(decoded[0] || 0),
      tickSpacing: Number(decoded[1] || 0),
      hooksAddress: String(decoded[2] || ZERO_ADDRESS).toLowerCase(),
      sqrtPriceX96: String(decoded[3] || ''),
      tick: Number(decoded[4] || 0),
      initializedBlock: Number(log.blockNumber),
      createdBlock: Number(log.blockNumber),
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      factoryAddress: config.poolManagerAddress,
      raw: {
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex)
      }
    };
  }

  async persistPools(pools) {
    if (!pools || pools.length === 0) {
      return 0;
    }

    const [v4Inserted, observedInserted] = await Promise.all([
      this.repository.upsertObservedV4Pools(this.chainConfig, pools),
      this.repository.upsertObservedPools(this.chainConfig, pools)
    ]);
    return v4Inserted + observedInserted;
  }

  async processActivityLogs(logs, config, options = {}) {
    const poolIds = logs
      .map(log => String(log.topics?.[1] || '').toLowerCase())
      .filter(poolId => this.isPoolId(poolId));
    if (poolIds.length === 0) {
      return { matched: 0, enqueued: 0 };
    }

    const poolMap = await this.repository.getObservedV4PoolsByIds(this.chainConfig, poolIds);
    const ignoreTokens = new Set((config.ignoreTokens || []).map(token => String(token || '').toLowerCase()));
    const scanDelayMs = Number(config.liquidityScanDelayMs || config.scanDelayMs || 15 * 60 * 1000);
    let matched = 0;
    let enqueued = 0;

    for (const log of logs) {
      const poolId = String(log.topics?.[1] || '').toLowerCase();
      const pool = poolMap.get(poolId);
      if (!pool) {
        continue;
      }

      matched += 1;
      const tokenAddresses = [pool.currency0_address, pool.currency1_address]
        .map(token => String(token || '').toLowerCase())
        .filter(token => token && token !== ZERO_ADDRESS && !ignoreTokens.has(token));
      const filterResult = await this.bytecodeFilter.filterTokenAddresses(tokenAddresses, {
        sourceKey: config.sourceKey,
        protocol: 'uniswap-v4',
        poolId,
        block: Number(log.blockNumber),
        tx: log.transactionHash || '',
        label: options.label || 'activity'
      });

      if (!options.dryRun) {
        await Promise.all([
          this.repository.markObservedPoolLiquidity(this.chainConfig, poolId, Number(log.blockNumber)),
          this.repository.markObservedV4PoolActivity(this.chainConfig, poolId, Number(log.blockNumber))
        ]);
        if (filterResult.skipped.length > 0) {
          await this.repository.disableScanTokensBatch(
            this.chainConfig,
            filterResult.skipped.map(item => item.tokenAddress),
            filterResult.skipped.map(item => item.reason).join(',')
          );
        }
        if (filterResult.allowed.length > 0) {
          const inserted = await this.repository.seedScanTokens(this.chainConfig, filterResult.allowed, `liquidity:${config.sourceKey}`, {
            delayMs: scanDelayMs,
            reschedule: true
          });
          enqueued += inserted;
        }
      } else {
        enqueued += filterResult.allowed.length;
      }

      console.log(
        `[${this.chainConfig.key}] discovery=${config.sourceKey} [${options.label || 'activity'}] active-v4-pool block=${Number(log.blockNumber)} poolId=${poolId} tokens=${filterResult.allowed.length > 0 ? filterResult.allowed.join(',') : 'all_filtered'} enqueued=${options.dryRun ? filterResult.allowed.length : enqueued} tx=${log.transactionHash || 'n/a'}`
      );
    }

    return { matched, enqueued };
  }

  config() {
    const raw = this.discoveryConfig || {};
    const poolManagerAddress = this.normalizeAddress(raw.poolManagerAddress || raw.factoryAddress);
    return {
      ...raw,
      protocol: 'uniswap-v4',
      sourceKey: raw.sourceKey || `${this.chainConfig.key.toLowerCase()}-uniswap-v4`,
      poolManagerAddress,
      factoryAddress: poolManagerAddress
    };
  }

  initializeTopic() {
    return this.web3.utils.sha3('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').toLowerCase();
  }

  modifyLiquidityTopic() {
    return this.web3.utils.sha3('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)').toLowerCase();
  }

  swapTopic() {
    return this.web3.utils.sha3('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').toLowerCase();
  }

  topicToAddress(topic) {
    const value = String(topic || '').toLowerCase();
    if (!value || value.length < 42) {
      return null;
    }
    return `0x${value.slice(-40)}`.toLowerCase();
  }

  isPoolId(value) {
    return /^0x[a-f0-9]{64}$/.test(String(value || '').toLowerCase());
  }

  normalizeAddress(address) {
    const value = String(address || '').trim();
    if (!value) {
      return '';
    }
    if (value.startsWith('0x') || value.startsWith('0X')) {
      return `0x${value.slice(2).toLowerCase()}`;
    }
    return value.toLowerCase();
  }

  resolveStartBlock(fromBlock, toBlock) {
    if (fromBlock === 'latest' || fromBlock === 'now') {
      return toBlock;
    }

    return Number(fromBlock || 0);
  }
}

module.exports = UniswapV4PoolDiscovery;
