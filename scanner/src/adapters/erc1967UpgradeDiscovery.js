const LoraiAuditClient = require('../lib/loraiAuditClient');
const { Erc1967ProxyInspector } = require('../lib/erc1967ProxyInspector');

const UPGRADED_TOPIC = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';

class Erc1967UpgradeDiscovery {
  constructor(web3, repository, chainConfig, source = null) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.source = source;
    this.inspector = new Erc1967ProxyInspector(web3);
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
  }

  async discover(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const rememberState = Boolean(options.rememberState);
    const config = this.chainConfig.scan?.proxyUpgrade || {};
    if (!config.enabled) {
      return 0;
    }
    if (config.backfillEnabled === false && !options.force) {
      const stateKey = config.sourceKey || `proxy-upgrade:${this.chainConfig.key.toLowerCase()}-erc1967-upgraded`;
      console.log(`[${this.chainConfig.key}] proxy-upgrade=${stateKey} backfill disabled; subscription-only`);
      return 0;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] proxy upgrade discovery 已启用但缺少 web3 client`);
    }

    const latestBlock = Number(await this.web3.eth.getBlockNumber());
    const toBlock = Math.max(0, latestBlock - (options.confirmations ?? config.confirmations ?? 0));
    const sourceKey = config.sourceKey || `proxy-upgrade:${this.chainConfig.key.toLowerCase()}-erc1967-upgraded`;
    const stateKey = options.stateKey || `${options.stateKeyPrefix || ''}${sourceKey}`;
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
      console.log(`[${this.chainConfig.key}] proxy-upgrade=${stateKey} 无新区块 from=${fromBlock} to=${toBlock}`);
      return 0;
    }

    const batchBlocks = Math.max(1, Number(options.batchBlocks || config.batchBlocks || 100));
    let processed = 0;
    let qualified = 0;

    while (fromBlock <= toBlock) {
      const batchToBlock = Math.min(toBlock, fromBlock + batchBlocks - 1);
      const logs = await this.web3.eth.getPastLogs({
        fromBlock,
        toBlock: batchToBlock,
        topics: [UPGRADED_TOPIC]
      });

      for (const log of logs) {
        try {
          const result = await this.handleLog(log, { dryRun });
          processed += result.processed ? 1 : 0;
          qualified += result.qualified ? 1 : 0;
        } catch (error) {
          console.error(`[${this.chainConfig.key}] proxy-upgrade=${stateKey} log 处理失败 block=${Number(log.blockNumber)} address=${log.address || 'n/a'} err=${error.message}`);
        }
      }

      if (!dryRun || rememberState) {
        await this.repository.upsertScannerState(this.chainConfig, stateKey, batchToBlock, {
          logs: logs.length,
          processed,
          qualified,
          topic: UPGRADED_TOPIC
        });
      }

      console.log(
        `[${this.chainConfig.key}] proxy-upgrade=${stateKey}${dryRun ? ' [dry-run]' : ''} blocks=${fromBlock}-${batchToBlock} logs=${logs.length} processed=${processed} qualified=${qualified}`
      );

      fromBlock = batchToBlock + 1;
    }

    return processed;
  }

  startSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const config = this.chainConfig.scan?.proxyUpgrade || {};
    if (!config.enabled || !config.subscribeEnabled) {
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] proxy upgrade subscription 已启用但缺少 web3 client`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const config = this.chainConfig.scan?.proxyUpgrade || {};
    const sourceKey = config.sourceKey || `proxy-upgrade:${this.chainConfig.key.toLowerCase()}-erc1967-upgraded`;
    this.subscription = this.web3.eth.subscribe('logs', {
      topics: [UPGRADED_TOPIC]
    });

    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription connected id=${id}`);
      })
      .on('data', log => {
        this.handleLog(log, { dryRun }).catch(error => {
          console.error(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription 处理失败: ${error.message}`);
        });
      })
      .on('changed', log => {
        console.log(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription removed block=${Number(log.blockNumber)} address=${log.address || 'n/a'} tx=${log.transactionHash || 'n/a'} logIndex=${Number(log.logIndex)}`);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const config = this.chainConfig.scan?.proxyUpgrade || {};
    const sourceKey = config.sourceKey || `proxy-upgrade:${this.chainConfig.key.toLowerCase()}-erc1967-upgraded`;
    const delayMs = Math.max(1000, Number(this.chainConfig.scan?.discovery?.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);
    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] proxy-upgrade=${sourceKey} subscription reconnect failed: ${reconnectError.message}`);
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

  async handleLog(log, options = {}) {
    if (log?.removed) {
      return { processed: false, qualified: false };
    }

    const tokenAddress = String(log.address || '').toLowerCase();
    if (!tokenAddress) {
      return { processed: false, qualified: false };
    }

    const config = this.chainConfig.scan?.proxyUpgrade || {};
    const known = await this.repository.isKnownTokenAsset(this.chainConfig, tokenAddress, config.ignoreTokens || []);
    if (!known) {
      return { processed: false, qualified: false };
    }

    const erc20Like = await this.inspector.isErc20Like(tokenAddress);
    if (!erc20Like) {
      console.log(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} 跳过 reason=not_erc20 block=${Number(log.blockNumber)} tx=${log.transactionHash || 'n/a'}`);
      return { processed: true, qualified: false };
    }

    const implementationAddress = await this.inspector.getImplementationAddress(tokenAddress);
    if (!implementationAddress) {
      console.log(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} 跳过 reason=no_erc1967_implementation block=${Number(log.blockNumber)} tx=${log.transactionHash || 'n/a'}`);
      return { processed: true, qualified: false };
    }

    const state = await this.repository.getTokenProxyState(this.chainConfig, tokenAddress);
    const oldImplementation = String(state?.implementation_address || '').toLowerCase();
    const changed = oldImplementation !== implementationAddress;
    const blockNumber = Number(log.blockNumber);

    if (options.dryRun) {
      if (changed) {
        console.log(`[${this.chainConfig.key}] proxy-upgrade [dry-run] token=${tokenAddress} oldImpl=${oldImplementation || 'n/a'} newImpl=${implementationAddress} block=${blockNumber} tx=${log.transactionHash || 'n/a'}`);
      } else {
        console.log(`[${this.chainConfig.key}] proxy-upgrade [dry-run] token=${tokenAddress} implementation 未变化 impl=${implementationAddress} block=${blockNumber}`);
      }
      return { processed: true, qualified: true };
    }

    await this.repository.upsertTokenProxyState(this.chainConfig, {
      tokenAddress,
      proxyType: 'erc1967',
      implementationAddress,
      lastCheckedBlock: blockNumber,
      lastChangeBlock: changed ? blockNumber : null
    });

    if (!changed) {
      console.log(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} implementation 未变化 impl=${implementationAddress} block=${blockNumber}`);
      return { processed: true, qualified: true };
    }

    const event = await this.repository.insertTokenProxyEvent(this.chainConfig, {
      tokenAddress,
      eventType: 'Upgraded',
      oldImplementation: oldImplementation || null,
      newImplementation: implementationAddress,
      txHash: log.transactionHash || '',
      blockNumber,
      logIndex: Number(log.logIndex),
      rawJson: log,
      qualifiedAsToken: true,
      auditAction: 'pending'
    });
    if (!event.inserted) {
      return { processed: true, qualified: true };
    }

    await this.processAuditForUpgrade(event.id, tokenAddress);
    return { processed: true, qualified: true };
  }

  async processAuditForUpgrade(eventId, tokenAddress) {
    const config = this.chainConfig.scan?.proxyUpgrade || {};
    if (!config.triggerAudit) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        auditAction: 'audit_disabled'
      });
      return;
    }
    if (!this.source || !this.source.scanTokenLiquidity) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        auditAction: 'missing_liquidity_source'
      });
      return;
    }

    const target = this.chainConfig.scan.targets?.[0];
    if (!target) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        auditAction: 'missing_target'
      });
      return;
    }

    let liquidityUsd = 0;
    try {
      const scanResult = await this.source.scanTokenLiquidity(target, tokenAddress);
      liquidityUsd = Number(scanResult?.liquidityUsd || 0);
    } catch (error) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        auditAction: 'liquidity_scan_failed',
        auditError: error.message
      });
      console.error(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} 流动性扫描失败 err=${error.message}`);
      return;
    }

    const thresholdUsd = Number(config.minLiquidityUsd || this.chainConfig.scan?.audit?.minLiquidityUsd || 40000);
    if (!Number.isFinite(liquidityUsd) || liquidityUsd < thresholdUsd) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        liquidityUsd,
        auditAction: 'skipped_low_liquidity'
      });
      console.log(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} LORAI 跳过 liquidityUsd=${this.formatUsd(liquidityUsd)} threshold=${thresholdUsd}`);
      return;
    }

    try {
      const result = await this.auditClient.recreateAudit(this.chainConfig, tokenAddress, {
        priority: this.chainConfig.scan?.audit?.priority
      });
      const auditAction = result.skipped ? `skipped_${result.reason}` : 'reaudit_triggered';
      await this.repository.updateTokenProxyEventAudit(eventId, {
        liquidityUsd,
        auditAction,
        auditRunId: result.runId || null
      });

      console.log(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} LORAI 重新审计 ${result.skipped ? `跳过 reason=${result.reason}` : `已触发 run_id=${result.runId || 'n/a'}`} liquidityUsd=${this.formatUsd(liquidityUsd)}`);
    } catch (error) {
      await this.repository.updateTokenProxyEventAudit(eventId, {
        liquidityUsd,
        auditAction: 'delete_or_create_failed',
        auditError: error.message
      });
      console.error(`[${this.chainConfig.key}] proxy-upgrade token=${tokenAddress} LORAI 重新审计失败 liquidityUsd=${this.formatUsd(liquidityUsd)} err=${error.message}`);
    }
  }

  resolveStartBlock(fromBlock, toBlock) {
    if (fromBlock === 'latest' || fromBlock === 'now') {
      return toBlock;
    }

    return Number(fromBlock || 0);
  }

  formatUsd(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : 'n/a';
  }
}

module.exports = Erc1967UpgradeDiscovery;
module.exports.UPGRADED_TOPIC = UPGRADED_TOPIC;
