const PrivateContractTokenSource = require('../adapters/privateContractTokenSource');
const AveLiquidityTokenSource = require('../adapters/aveLiquidityTokenSource');
const UniswapV2PairDiscovery = require('../adapters/uniswapV2PairDiscovery');
const UniswapV4PoolDiscovery = require('../adapters/uniswapV4PoolDiscovery');
const LiquidityEventDiscovery = require('../adapters/liquidityEventDiscovery');
const Erc1967UpgradeDiscovery = require('../adapters/erc1967UpgradeDiscovery');
const MethodCallDiscovery = require('../adapters/methodCallDiscovery');
const ContractValueMonitor = require('../adapters/contractValueMonitor');
const FlapVaultFactoryDiscovery = require('../adapters/flapVaultFactoryDiscovery');
const AveLiquidityClient = require('../lib/aveLiquidityClient');

class TokenScannerService {
  constructor({ chainConfig, web3, repository, dryRun = false, listenOnly = false, observeAve = false }) {
    this.chainConfig = chainConfig;
    this.web3 = web3;
    this.repository = repository;
    this.dryRun = dryRun;
    this.listenOnly = listenOnly;
    this.observeAve = observeAve;
    this.startedAt = new Date();
    if (this.chainConfig.scan?.skipExistingDueTokens) {
      this.chainConfig.scan.dueUpdatedAfter = this.startedAt;
    }
    this.source = this.listenOnly && !this.observeAve ? null : this.createSource();
    this.discoveries = this.createDiscoveries();
    this.liquidityDiscoveries = this.createLiquidityDiscoveries();
    this.proxyUpgradeDiscoveries = this.createProxyUpgradeDiscoveries();
    this.methodCallDiscoveries = this.createMethodCallDiscoveries();
    this.contractValueMonitors = this.createContractValueMonitors();
    this.flapVaultFactoryDiscoveries = this.createFlapVaultFactoryDiscoveries();
    this.realtimeSubscriptions = [];
    this.running = false;
    this.scanCycleRunning = false;
  }

  createDiscoveries() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const discoveryConfigs = this.chainConfig.scan.discoveries || [this.chainConfig.scan.discovery];
    return discoveryConfigs
      .filter(config => config?.enabled)
      .map(config => (
        String(config?.protocol || '').toLowerCase().includes('v4')
          ? new UniswapV4PoolDiscovery(this.web3, this.repository, this.chainConfig, config)
          : new UniswapV2PairDiscovery(this.web3, this.repository, this.chainConfig, config)
      ));
  }

  createLiquidityDiscoveries() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const discoveryConfigs = this.chainConfig.scan.discoveries || [this.chainConfig.scan.discovery];
    return discoveryConfigs
      .filter(config => config?.enabled && config?.liquidityTrigger !== false && !String(config?.protocol || '').toLowerCase().includes('v4'))
      .map(config => new LiquidityEventDiscovery(this.web3, this.repository, this.chainConfig, config));
  }

  hasDiscovery() {
    return this.discoveries.length > 0
      || this.liquidityDiscoveries.length > 0
      || this.proxyUpgradeDiscoveries.length > 0
      || this.methodCallDiscoveries.length > 0
      || this.contractValueMonitors.length > 0
      || this.flapVaultFactoryDiscoveries.length > 0;
  }

  createProxyUpgradeDiscoveries() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const config = this.chainConfig.scan?.proxyUpgrade;
    if (!config?.enabled) {
      return [];
    }

    return [new Erc1967UpgradeDiscovery(this.web3, this.repository, this.chainConfig, this.source)];
  }

  createMethodCallDiscoveries() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const config = this.chainConfig.scan?.methodCallMonitor;
    if (!config?.enabled) {
      return [];
    }

    return [new MethodCallDiscovery(this.web3, this.repository, this.chainConfig)];
  }

  createContractValueMonitors() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const config = this.chainConfig.scan?.contractValueMonitor;
    if (!config?.enabled) {
      return [];
    }

    return [new ContractValueMonitor(this.web3, this.repository, this.chainConfig)];
  }

  createFlapVaultFactoryDiscoveries() {
    if (this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return [];
    }

    const config = this.chainConfig.scan?.flapVaultFactory;
    if (!config?.enabled) {
      return [];
    }

    return [new FlapVaultFactoryDiscovery(this.web3, this.repository, this.chainConfig)];
  }

  async runDiscoveries() {
    for (const discovery of this.discoveries) {
      await discovery.discover({ dryRun: this.dryRun, rememberState: this.listenOnly });
    }
    for (const discovery of this.liquidityDiscoveries) {
      await discovery.discover({
        dryRun: this.dryRun,
        rememberState: this.listenOnly,
        onTokenDiscovered: this.observeAve
          ? event => this.observeAveLiquidity(event)
          : null
      });
    }
    for (const discovery of this.proxyUpgradeDiscoveries) {
      await discovery.discover({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
    }
    for (const discovery of this.flapVaultFactoryDiscoveries) {
      await discovery.discover({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
    }
  }

  async observeAveLiquidity(event) {
    if (!this.source || this.chainConfig.scan.sourceType !== 'ave_liquidity_v1') {
      return;
    }

    const target = this.chainConfig.scan.targets[0];
    if (!target) {
      console.log(`[${this.chainConfig.key}] observe-ave 没有可用 target，跳过 token=${event.tokenAddresses.join(',')}`);
      return;
    }

    for (const tokenAddress of event.tokenAddresses) {
      await this.source.scanToken(target, tokenAddress, true, {
        printResponse: true,
        context: {
          sourceKey: event.sourceKey,
          protocol: event.protocol,
          poolAddress: event.pool?.pool_address,
          blockNumber: Number(event.log?.blockNumber),
          txHash: event.log?.transactionHash
        }
      });
    }
  }

  startRealtimeSubscriptions() {
    if (!this.web3 || !this.hasDiscovery()) {
      return;
    }

    const onTokenDiscovered = this.observeAve
      ? event => this.observeAveLiquidity(event)
      : null;
    console.log(`[${this.chainConfig.key}] Pair/Mint/Proxy/Flap/method-call/contract-value 使用 WebSocket 订阅`);

    for (const discovery of this.discoveries) {
      const subscription = discovery.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    for (const discovery of this.liquidityDiscoveries) {
      const subscription = discovery.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly,
        onTokenDiscovered
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    for (const discovery of this.proxyUpgradeDiscoveries) {
      const subscription = discovery.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    for (const discovery of this.flapVaultFactoryDiscoveries) {
      const subscription = discovery.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    for (const discovery of this.methodCallDiscoveries) {
      const subscription = discovery.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    for (const monitor of this.contractValueMonitors) {
      const subscription = monitor.startSubscription?.({
        dryRun: this.dryRun,
        rememberState: this.listenOnly
      });
      if (subscription) {
        this.realtimeSubscriptions.push(subscription);
      }
    }

    if (this.realtimeSubscriptions.length > 0) {
      console.log(`[${this.chainConfig.key}] realtime subscriptions started count=${this.realtimeSubscriptions.length}`);
    }
  }

  createSource() {
    const sourceType = this.chainConfig.scan.sourceType || 'private_contract_v1';
    if (sourceType === 'ave_liquidity_v1') {
      return new AveLiquidityTokenSource(
        new AveLiquidityClient(this.chainConfig.scan.ave || {}),
        this.repository,
        this.chainConfig,
        this.web3
      );
    }

    return new PrivateContractTokenSource(this.web3, this.repository, this.chainConfig);
  }

  async bootstrap() {
    if (!this.listenOnly) {
      await this.repository.testConnection();
    }
    if (!this.listenOnly && this.source.bootstrap) {
      await this.source.bootstrap();
    }
    if (!this.listenOnly && this.proxyUpgradeDiscoveries.length > 0 && this.repository.migrateProxyUpgradeSchema) {
      await this.repository.migrateProxyUpgradeSchema();
    }

    if (this.web3) {
      const blockNumber = await this.web3.eth.getBlockNumber();
      console.log(`[${this.chainConfig.key}] RPC 连通，当前区块=${blockNumber}`);
    } else {
      console.log(`[${this.chainConfig.key}] source=${this.chainConfig.scan.sourceType} 不需要链上 RPC`);
    }
    console.log(`[${this.chainConfig.key}] DB=${this.listenOnly ? 'skipped(listen-only)' : this.chainConfig.db.database}`);
    console.log(`[${this.chainConfig.key}] dryRun=${this.dryRun}`);
    console.log(`[${this.chainConfig.key}] listenOnly=${this.listenOnly}`);
    console.log(`[${this.chainConfig.key}] observeAve=${this.observeAve}`);
    if (this.chainConfig.scan?.calibration) {
      console.log(
        `[${this.chainConfig.key}] liquidityCalibration=${this.chainConfig.scan.calibration.enabled ? 'enabled' : 'disabled'} maxPairs=${this.chainConfig.scan.calibration.maxPairs || 'n/a'}`
      );
    }
    if (this.chainConfig.scan?.bytecodeFilter) {
      const filter = this.chainConfig.scan.bytecodeFilter;
      console.log(
        `[${this.chainConfig.key}] tokenBytecodeFilter=${filter.enabled ? 'enabled' : 'disabled'} rules=${(filter.rules || []).length}`
      );
    }
    if (this.chainConfig.scan?.dueSourcePrefix) {
      console.log(`[${this.chainConfig.key}] dueSourcePrefix=${this.chainConfig.scan.dueSourcePrefix}`);
    }
    if (this.chainConfig.scan?.skipExistingDueTokens) {
      console.log(`[${this.chainConfig.key}] skipExistingDueTokens=enabled dueUpdatedAfter=${this.chainConfig.scan.dueUpdatedAfter.toISOString()}`);
    }
    if (this.chainConfig.scan?.proxyUpgrade?.enabled) {
      console.log(
        `[${this.chainConfig.key}] proxyUpgradeMonitor=enabled minLiquidityUsd=${this.chainConfig.scan.proxyUpgrade.minLiquidityUsd} subscribe=${this.chainConfig.scan.proxyUpgrade.subscribeEnabled ? 'enabled' : 'disabled'}`
      );
    }
    if (this.chainConfig.scan?.methodCallMonitor?.enabled) {
      const configuredSelectors = (this.chainConfig.scan.methodCallMonitor.methods || [])
        .map(item => `${item.name || item.selector}:${item.selector}`)
        .join(',');
      const signatureCount = (this.chainConfig.scan.methodCallMonitor.signatures || []).length;
      console.log(
        `[${this.chainConfig.key}] methodCallMonitor=enabled minValueUsd=${this.chainConfig.scan.methodCallMonitor.minValueUsd} subscribe=${this.chainConfig.scan.methodCallMonitor.subscribeEnabled ? 'enabled' : 'disabled'} configuredSelectors=${configuredSelectors || 'none'} defaultSignatures=${signatureCount} concurrentBlocks=${this.chainConfig.scan.methodCallMonitor.maxConcurrentBlocks || 1} concurrentTx=${this.chainConfig.scan.methodCallMonitor.maxConcurrentTransactions || 1} rpcTimeoutMs=${this.chainConfig.scan.methodCallMonitor.rpcTimeoutMs || 'n/a'}`
      );
    }
    if (this.chainConfig.scan?.contractValueMonitor?.enabled) {
      const monitor = this.chainConfig.scan.contractValueMonitor;
      const assetSummary = [
        monitor.nativeAsset?.symbol
          ? `${monitor.nativeAsset.symbol}:amount>=${monitor.nativeAsset.minAmount || 0},usd>=${monitor.nativeAsset.minValueUsd || 0}`
          : '',
        ...(monitor.coreAssets || []).map(asset => `${asset.symbol}:amount>=${asset.minAmount || 0},usd>=${asset.minValueUsd || 0}`)
      ].filter(Boolean).join(',');
      console.log(
        `[${this.chainConfig.key}] contractValueMonitor=enabled subscribe=${monitor.subscribeEnabled ? 'enabled' : 'disabled'} observeOnly=${monitor.triggerScan ? 'false' : 'true'} minTotalUsd=${monitor.minTotalUsd} maxContractsPerBlock=${monitor.maxContractsPerBlock} assets=${assetSummary || 'none'}`
      );
    }
    if (this.chainConfig.scan?.flapVaultFactory?.enabled) {
      const monitor = this.chainConfig.scan.flapVaultFactory;
      console.log(
        `[${this.chainConfig.key}] flapVaultFactoryMonitor=enabled portal=${monitor.portalAddress} subscribe=${monitor.subscribeEnabled ? 'enabled' : 'disabled'} triggerAudit=${monitor.triggerAudit ? 'enabled' : 'disabled'} backfill=${monitor.backfillEnabled ? 'enabled' : 'disabled'}`
      );
    }
    console.log(`[${this.chainConfig.key}] eventMode=websocket-subscription-only; long-running poll:* history catch-up disabled`);

    for (const target of this.listenOnly ? [] : this.chainConfig.scan.targets) {
      const routerSummary = (target.routers || [])
        .map(router => `${router.name}:${router.address}`)
        .join(', ');
      console.log(
        `[${this.chainConfig.key}] target=${target.name} source=${this.chainConfig.scan.sourceType} dexType=${target.dexType || 'n/a'} tokenTable=${target.tokenTable || 'n/a'} factoryTable=${target.factoryTable || 'n/a'} routers=${routerSummary || 'none'}`
      );
    }
  }

  async runScanCycle() {
    if (this.scanCycleRunning) {
      console.log(`[${this.chainConfig.key}] scan cycle 已在运行，跳过本次触发`);
      return;
    }

    this.scanCycleRunning = true;
    try {
      if (this.listenOnly) {
        console.log(`[${this.chainConfig.key}] listen-only 模式已启用，仅监听新增资产，不处理待扫 token 队列`);
        return;
      }

      for (const target of this.chainConfig.scan.targets) {
        await this.source.scanTarget(target, { dryRun: this.dryRun });
      }
    } finally {
      this.scanCycleRunning = false;
    }
  }

  async runRefreshCycle() {
    if (this.chainConfig.scan.sourceType === 'ave_liquidity_v1') {
      await this.runScanCycle();
      return;
    }

    const staleBefore = Date.now() - this.chainConfig.scan.staleAfterMs;

    for (const target of this.chainConfig.scan.targets) {
      const tokenIds = await this.repository.getStaleTokenIds(
        target.tokenTable,
        staleBefore,
        this.chainConfig.scan.updateLimit
      );
      await this.source.refreshTarget(target, tokenIds);
    }
  }

  async runTopPoolCycle() {
    if (this.chainConfig.scan.sourceType === 'ave_liquidity_v1') {
      return;
    }

    for (const target of this.chainConfig.scan.targets) {
      const tokenIds = await this.repository.getTopTokenIds(
        target.tokenTable,
        target.topPoolFields || [],
        100
      );
      await this.source.refreshTarget(target, tokenIds);
    }
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.bootstrap();

    this.startRealtimeSubscriptions();
    await this.runScanCycle();
    if (!this.dryRun && !this.listenOnly) {
      await this.runTopPoolCycle();
    }

    setInterval(() => {
      this.runScanCycle().catch(error => {
        console.error(`[${this.chainConfig.key}] scan cycle 失败: ${error.message}`);
      });
    }, this.chainConfig.scan.scanIntervalMs);

    if (!this.dryRun && !this.listenOnly) {
      setInterval(() => {
        this.runRefreshCycle().catch(error => {
          console.error(`[${this.chainConfig.key}] refresh cycle 失败: ${error.message}`);
        });
      }, this.chainConfig.scan.refreshIntervalMs);

      setInterval(() => {
        this.runTopPoolCycle().catch(error => {
          console.error(`[${this.chainConfig.key}] top pool cycle 失败: ${error.message}`);
        });
      }, this.chainConfig.scan.topPoolIntervalMs);
    } else {
      console.log(`[${this.chainConfig.key}] dry-run 模式已启用，仅扫描新增数据，不写库，不刷新旧数据`);
    }
  }
}

module.exports = TokenScannerService;
