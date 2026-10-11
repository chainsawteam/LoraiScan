const discoveryTopics = {
  'uniswap-v2': '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  'uniswap-v3': '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'
};

class UniswapV2PairDiscovery {
  constructor(web3, repository, chainConfig, discoveryConfig = null) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.discoveryConfig = discoveryConfig;
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.recentBackfillRunning = false;
  }

  async discover(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const rememberState = Boolean(options.rememberState);
    const config = this.discoveryConfig || this.chainConfig.scan.discovery || {};
    if (!config.enabled) {
      return 0;
    }
    if (config.backfillEnabled === false && !options.force) {
      const protocol = config.protocol || 'uniswap-v2';
      const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
      console.log(`[${this.chainConfig.key}] discovery=${sourceKey} backfill disabled; subscription-only`);
      return 0;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] discovery 已启用但缺少 web3 client`);
    }
    if (!config.factoryAddress) {
      throw new Error(`[${this.chainConfig.key}] discovery 缺少 factoryAddress`);
    }

    const protocol = config.protocol || 'uniswap-v2';
    const topic = discoveryTopics[protocol];
    if (!topic) {
      throw new Error(`[${this.chainConfig.key}] discovery 不支持协议: ${protocol}`);
    }

    const latestBlock = Number(await this.web3.eth.getBlockNumber());
    const toBlock = Math.max(0, latestBlock - (options.confirmations ?? config.confirmations ?? 0));
    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const stateKey = options.stateKey || `${options.stateKeyPrefix || ''}factory:${sourceKey}`;
    const state = await this.repository.getScannerState(this.chainConfig, stateKey);
    const startBlock = await this.resolveStartBlock(config.fromBlock, toBlock);
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
    const ignoreTokens = new Set((config.ignoreTokens || []).map(token => token.toLowerCase()));
    let discovered = 0;

    while (fromBlock <= toBlock) {
      const batchToBlock = Math.min(toBlock, fromBlock + batchBlocks - 1);
      const logs = await this.web3.eth.getPastLogs({
        address: config.factoryAddress,
        fromBlock,
        toBlock: batchToBlock,
        topics: [topic]
      });

      const pools = this.logsToPools(logs, protocol, sourceKey, config.factoryAddress, ignoreTokens);

      if (dryRun && pools.length > 0) {
        for (const pool of pools) {
          console.log(
            `[${this.chainConfig.key}] discovery=${sourceKey} [dry-run] new-pool protocol=${protocol} block=${pool.createdBlock} pool=${pool.poolAddress} token0=${pool.token0} token1=${pool.token1} tx=${pool.txHash || 'n/a'} logIndex=${pool.logIndex}`
          );
        }
      }

      const shouldRememberPools = dryRun && this.repository.dryRunMemoryState;
      const inserted = (dryRun && !shouldRememberPools) || pools.length === 0
        ? 0
        : await this.repository.upsertObservedPools(this.chainConfig, pools);
      discovered += inserted;

      if (!dryRun || rememberState) {
        await this.repository.upsertScannerState(this.chainConfig, stateKey, batchToBlock, {
          factoryAddress: config.factoryAddress,
          protocol,
          sourceKey,
          logs: logs.length,
          pools: pools.length,
          inserted
        });
      }

      console.log(
        `[${this.chainConfig.key}] discovery=${sourceKey} protocol=${protocol}${dryRun ? ' [dry-run]' : ''} blocks=${fromBlock}-${batchToBlock} logs=${logs.length} pools=${pools.length}`
      );

      fromBlock = batchToBlock + 1;
    }

    return discovered;
  }

  startSubscription(options = {}) {
    const config = this.discoveryConfig || this.chainConfig.scan.discovery || {};
    if (!config.enabled || !config.subscribeEnabled) {
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] discovery subscription 已启用但缺少 web3 client`);
    }
    if (!config.factoryAddress) {
      throw new Error(`[${this.chainConfig.key}] discovery subscription 缺少 factoryAddress`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const config = this.discoveryConfig || this.chainConfig.scan.discovery || {};
    const protocol = config.protocol || 'uniswap-v2';
    const topic = discoveryTopics[protocol];
    if (!topic) {
      throw new Error(`[${this.chainConfig.key}] discovery subscription 不支持协议: ${protocol}`);
    }

    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const ignoreTokens = new Set((config.ignoreTokens || []).map(token => token.toLowerCase()));
    this.subscription = this.web3.eth.subscribe('logs', {
      address: config.factoryAddress,
      topics: [topic]
    });

    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] discovery=${sourceKey} subscription connected id=${id}`);
        this.backfillRecentBlocks({
          dryRun,
          protocol,
          sourceKey,
          factoryAddress: config.factoryAddress,
          ignoreTokens,
          topic
        }).catch(error => {
          console.error(`[${this.chainConfig.key}] discovery=${sourceKey} recent-backfill 失败: ${error.message}`);
        });
      })
      .on('data', log => {
        this.handleSubscriptionLog(log, {
          dryRun,
          protocol,
          sourceKey,
          factoryAddress: config.factoryAddress,
          ignoreTokens
        }).catch(error => {
          console.error(`[${this.chainConfig.key}] discovery=${sourceKey} subscription 处理失败: ${error.message}`);
        });
      })
      .on('changed', log => {
        console.log(`[${this.chainConfig.key}] discovery=${sourceKey} subscription removed block=${Number(log.blockNumber)} tx=${log.transactionHash || 'n/a'} logIndex=${Number(log.logIndex)}`);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] discovery=${sourceKey} subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] discovery=${sourceKey} subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] discovery=${sourceKey} subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const config = this.discoveryConfig || this.chainConfig.scan.discovery || {};
    const protocol = config.protocol || 'uniswap-v2';
    const sourceKey = config.sourceKey || `${this.chainConfig.key.toLowerCase()}-${protocol}`;
    const delayMs = Math.max(1000, Number(config.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] discovery=${sourceKey} subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);

    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.subscription = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] discovery=${sourceKey} subscription reconnect failed: ${reconnectError.message}`);
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
    const config = this.discoveryConfig || this.chainConfig.scan.discovery || {};
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
        address: options.factoryAddress,
        fromBlock,
        toBlock,
        topics: [options.topic]
      });
      const pools = this.logsToPools(
        logs,
        options.protocol,
        options.sourceKey,
        options.factoryAddress,
        options.ignoreTokens
      );
      const inserted = options.dryRun && !this.repository.dryRunMemoryState
        ? 0
        : await this.repository.upsertObservedPools(this.chainConfig, pools);

      for (const pool of pools) {
        console.log(
          `[${this.chainConfig.key}] discovery=${options.sourceKey} [recent-backfill] new-pool protocol=${options.protocol} block=${pool.createdBlock} pool=${pool.poolAddress} token0=${pool.token0} token1=${pool.token1} inserted=${inserted}`
        );
      }
      console.log(`[${this.chainConfig.key}] discovery=${options.sourceKey} recent-backfill blocks=${fromBlock}-${toBlock} logs=${logs.length} pools=${pools.length} inserted=${inserted}`);
      return inserted;
    } finally {
      this.recentBackfillRunning = false;
    }
  }

  async handleSubscriptionLog(log, options) {
    if (log?.removed) {
      return;
    }

    const pools = this.logsToPools(
      [log],
      options.protocol,
      options.sourceKey,
      options.factoryAddress,
      options.ignoreTokens
    );
    if (pools.length === 0) {
      return;
    }

    if (options.dryRun && !this.repository.dryRunMemoryState) {
      for (const pool of pools) {
        console.log(
          `[${this.chainConfig.key}] discovery=${options.sourceKey} [subscribe][dry-run] new-pool protocol=${options.protocol} block=${pool.createdBlock} pool=${pool.poolAddress} token0=${pool.token0} token1=${pool.token1} tx=${pool.txHash || 'n/a'} logIndex=${pool.logIndex}`
        );
      }
      return;
    }

    const inserted = await this.repository.upsertObservedPools(this.chainConfig, pools);
    for (const pool of pools) {
      console.log(
        `[${this.chainConfig.key}] discovery=${options.sourceKey} [subscribe] new-pool protocol=${options.protocol} block=${pool.createdBlock} pool=${pool.poolAddress} token0=${pool.token0} token1=${pool.token1} inserted=${inserted}`
      );
    }
  }

  logsToPools(logs, protocol, sourceKey, factoryAddress, ignoreTokens) {
    const pools = [];
    for (const log of logs) {
      const pool = this.parsePoolCreatedLog(log, protocol);
      if (!pool) {
        continue;
      }
      if (ignoreTokens.has(pool.token0) && ignoreTokens.has(pool.token1)) {
        continue;
      }
      pools.push({
        ...pool,
        sourceKey,
        protocol,
        factoryAddress,
        createdBlock: Number(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex)
      });
    }

    return pools;
  }

  topicToAddress(topic) {
    if (!topic || topic.length < 42) {
      return null;
    }

    return `0x${topic.slice(-40)}`.toLowerCase();
  }

  parsePoolCreatedLog(log, protocol) {
    const token0 = this.topicToAddress(log.topics[1]);
    const token1 = this.topicToAddress(log.topics[2]);
    const words = this.dataToWords(log.data);
    const poolAddress = protocol === 'uniswap-v3'
      ? this.wordToAddress(words[1])
      : this.wordToAddress(words[0]);

    if (!token0 || !token1 || !poolAddress) {
      return null;
    }

    return {
      token0,
      token1,
      poolAddress
    };
  }

  dataToWords(data) {
    const value = String(data || '').replace(/^0x/, '');
    const words = [];
    for (let index = 0; index < value.length; index += 64) {
      words.push(`0x${value.slice(index, index + 64)}`);
    }

    return words;
  }

  wordToAddress(word) {
    if (!word || word.length < 42) {
      return null;
    }

    return `0x${word.slice(-40)}`.toLowerCase();
  }

  async resolveStartBlock(fromBlock, toBlock) {
    if (fromBlock === 'latest') {
      return toBlock;
    }
    if (fromBlock === 'now') {
      return toBlock;
    }

    return Number(fromBlock || 0);
  }
}

module.exports = UniswapV2PairDiscovery;
