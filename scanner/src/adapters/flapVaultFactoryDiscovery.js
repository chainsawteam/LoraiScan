const LoraiAuditClient = require('../lib/loraiAuditClient');

const FLAP_FACTORY_REGISTERED_EVENT = 'FlapTaxVaultFactoryRegistered(address,bool,bool,uint8)';

class FlapVaultFactoryDiscovery {
  constructor(web3, repository, chainConfig) {
    this.web3 = web3;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.config = chainConfig.scan?.flapVaultFactory || {};
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.subscription = null;
    this.subscriptionOptions = null;
    this.reconnectTimer = null;
    this.topic = web3?.utils?.sha3(FLAP_FACTORY_REGISTERED_EVENT);
    this.eventInputs = [
      { indexed: false, name: 'factory', type: 'address' },
      { indexed: false, name: 'enabled', type: 'bool' },
      { indexed: false, name: 'official', type: 'bool' },
      { indexed: false, name: 'riskLevel', type: 'uint8' }
    ];
  }

  async discover(options = {}) {
    const dryRun = Boolean(options.dryRun);
    if (!this.config.enabled) {
      return 0;
    }
    if (this.config.backfillEnabled === false && !options.force) {
      console.log(`[${this.chainConfig.key}] flap-vault-factory backfill disabled; subscription-only`);
      return 0;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] flap vault factory discovery 已启用但缺少 web3 client`);
    }

    const latestBlock = Number(await this.web3.eth.getBlockNumber());
    const toBlock = Math.max(0, latestBlock - (options.confirmations ?? this.config.confirmations ?? 0));
    const sourceKey = this.config.sourceKey || `flap:${this.chainConfig.key.toLowerCase()}-vault-factory`;
    const stateKey = options.stateKey || `${options.stateKeyPrefix || ''}${sourceKey}`;
    const state = await this.repository.getScannerState(this.chainConfig, stateKey);
    const startBlock = this.resolveStartBlock(this.config.fromBlock, toBlock);
    let fromBlock = state?.last_block === undefined || state?.last_block === null
      ? startBlock
      : Number(state.last_block) + 1;
    if ((state?.last_block === undefined || state?.last_block === null) && Number(options.initialBackfillBlocks || 0) > 0) {
      const recentStartBlock = Math.max(0, toBlock - Number(options.initialBackfillBlocks) + 1);
      fromBlock = fromBlock >= toBlock ? recentStartBlock : Math.max(fromBlock, recentStartBlock);
    }

    if (fromBlock > toBlock) {
      console.log(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} 无新区块 from=${fromBlock} to=${toBlock}`);
      return 0;
    }

    const batchBlocks = Math.max(1, Number(options.batchBlocks || this.config.batchBlocks || 100));
    let processed = 0;
    let submitted = 0;

    while (fromBlock <= toBlock) {
      const batchToBlock = Math.min(toBlock, fromBlock + batchBlocks - 1);
      const logs = await this.web3.eth.getPastLogs({
        fromBlock,
        toBlock: batchToBlock,
        address: this.config.portalAddress,
        topics: [this.topic]
      });

      for (const log of logs) {
        try {
          const result = await this.handleLog(log, { dryRun });
          processed += result.processed ? 1 : 0;
          submitted += result.submitted ? 1 : 0;
        } catch (error) {
          console.error(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} log 处理失败 block=${Number(log.blockNumber)} tx=${log.transactionHash || 'n/a'} err=${error.message}`);
        }
      }

      if (!dryRun || options.rememberState) {
        await this.repository.upsertScannerState(this.chainConfig, stateKey, batchToBlock, {
          logs: logs.length,
          processed,
          submitted,
          portalAddress: this.config.portalAddress,
          topic: this.topic
        });
      }

      console.log(`[${this.chainConfig.key}] flap-vault-factory=${stateKey}${dryRun ? ' [dry-run]' : ''} blocks=${fromBlock}-${batchToBlock} logs=${logs.length} processed=${processed} submitted=${submitted}`);
      fromBlock = batchToBlock + 1;
    }

    return processed;
  }

  startSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    if (!this.config.enabled || !this.config.subscribeEnabled) {
      return null;
    }
    if (this.subscription) {
      return this.subscription;
    }
    if (!this.web3) {
      throw new Error(`[${this.chainConfig.key}] flap vault factory subscription 已启用但缺少 web3 client`);
    }

    this.subscriptionOptions = options;
    return this.openSubscription(options);
  }

  openSubscription(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const sourceKey = this.config.sourceKey || `flap:${this.chainConfig.key.toLowerCase()}-vault-factory`;
    this.subscription = this.web3.eth.subscribe('logs', {
      address: this.config.portalAddress,
      topics: [this.topic]
    });

    this.subscription
      .on('connected', id => {
        console.log(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription connected id=${id} portal=${this.config.portalAddress} topic=${this.topic}`);
      })
      .on('data', log => {
        this.handleLog(log, { dryRun }).catch(error => {
          console.error(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription 处理失败: ${error.message}`);
        });
      })
      .on('changed', log => {
        console.log(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription removed block=${Number(log.blockNumber)} tx=${log.transactionHash || 'n/a'} logIndex=${Number(log.logIndex)}`);
      })
      .on('error', error => {
        console.error(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription error: ${error.message || error}`);
        this.scheduleReconnect('error', error);
      })
      .on('end', error => {
        console.error(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription end: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('end', error);
      })
      .on('close', error => {
        console.error(`[${this.chainConfig.key}] flap-vault-factory=${sourceKey} subscription close: ${error?.message || error || 'n/a'}`);
        this.scheduleReconnect('close', error);
      });

    return this.subscription;
  }

  scheduleReconnect(reason, error) {
    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.max(1000, Number(this.chainConfig.scan?.discovery?.subscriptionReconnectDelayMs || 5000));
    console.warn(`[${this.chainConfig.key}] flap-vault-factory=${this.config.sourceKey || 'flap-vault-factory'} subscription reconnect scheduled reason=${reason} delayMs=${delayMs} err=${error?.message || error || 'n/a'}`);
    this.closeSubscription();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openSubscription(this.subscriptionOptions || {});
      } catch (reconnectError) {
        console.error(`[${this.chainConfig.key}] flap-vault-factory subscription reconnect failed: ${reconnectError.message}`);
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
      return { processed: false, submitted: false };
    }

    const event = this.decodeLog(log);
    const factory = String(event.factory || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(factory)) {
      console.log(`[${this.chainConfig.key}] flap-vault-factory 跳过 reason=invalid_factory factory=${event.factory || 'n/a'} tx=${log.transactionHash || 'n/a'}`);
      return { processed: true, submitted: false };
    }

    const blockNumber = Number(log.blockNumber);
    const riskLevel = Number(event.riskLevel);
    const prefix = `[${this.chainConfig.key}] flap-vault-factory factory=${factory} enabled=${event.enabled} official=${event.official} riskLevel=${Number.isFinite(riskLevel) ? riskLevel : 'n/a'} block=${blockNumber} tx=${log.transactionHash || 'n/a'}`;

    if (options.dryRun) {
      console.log(`${prefix} LORAI dry-run`);
      return { processed: true, submitted: false };
    }

    if (!this.config.triggerAudit) {
      console.log(`${prefix} LORAI 跳过 reason=audit_disabled`);
      return { processed: true, submitted: false };
    }

    try {
      const result = await this.auditClient.ensureAudit(this.chainConfig, factory, {
        priority: this.config.priority
      });
      console.log(`${prefix} LORAI ${result.skipped ? `跳过 reason=${result.reason}` : `已触发 run_id=${result.runId || 'n/a'}`}`);
      return { processed: true, submitted: !result.skipped };
    } catch (error) {
      console.error(`${prefix} LORAI 触发失败 err=${error.message}`);
      return { processed: true, submitted: false };
    }
  }

  decodeLog(log) {
    try {
      return this.web3.eth.abi.decodeLog(this.eventInputs, log.data || '0x', (log.topics || []).slice(1));
    } catch (error) {
      throw new Error(`decode FlapTaxVaultFactoryRegistered failed: ${error.message}`);
    }
  }

  resolveStartBlock(fromBlock, toBlock) {
    if (fromBlock === 'latest' || fromBlock === 'now') {
      return toBlock;
    }

    return Number(fromBlock || 0);
  }
}

module.exports = FlapVaultFactoryDiscovery;
module.exports.FLAP_FACTORY_REGISTERED_EVENT = FLAP_FACTORY_REGISTERED_EVENT;
