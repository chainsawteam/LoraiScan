# token-db-manager-js 迁移说明

## 目录目的

该目录用于承接生产机 `/ssd0/js/token` 下的旧版 Token/Contract 数据采集与分析逻辑，先按原样迁移进当前仓库，后续再逐步做统一治理、多链抽象和与现有 Go 工具链整合。

当前已经在迁移基础上做了第一轮结构规整，形成了“兼容旧入口 + 新 `src/` 结构”的布局。

## 当前目录结构

```text
tools/token-db-manager-js/
├── ecosystem.config.js         # PM2 多进程启动配置
├── src/
│   ├── api/
│   │   └── createApp.js        # 新 API 应用组装
│   ├── apps/
│   │   └── scan-worker.js      # 单链扫描进程入口
│   │   └── api-server.js       # 新 API 服务入口
│   ├── adapters/
│   │   └── privateContractTokenSource.js
│   ├── config/
│   │   ├── chains.js           # 多链静态定义
│   │   └── runtime.js          # 环境变量合并与启用链解析
│   ├── db/
│   │   └── createPool.js
│   ├── lib/
│   │   └── createWeb3Client.js
│   ├── repositories/
│   │   ├── tokenRepository.js
│   │   └── loraRepository.js
│   └── services/
│       └── tokenScannerService.js
├── getToken.js                 # 旧入口兼容包装
├── getTokenCode.js             # 旧入口兼容包装
├── server.js                   # 旧 API 入口兼容包装
├── contractAnalyzer.js         # 多链合约分析入口
└── lib/                        # 合约分析旧模块
```

主要包含三块能力：

1. `getToken.js` / `getTokenCode.js`
   负责从链上读取 Token 池子信息，并写入 `token` 数据库。
2. `contractAnalyzer.js` + `lib/`
   负责针对 `lora.new_contracts` 做多链合约字节码分析、函数提取和 Fuzz 测试。
3. `src/apps/api-server.js`
   负责新的 Token / Notifications / Contracts API 服务入口。

## 已迁移内容

- `getToken.js`
- `getTokenCode.js`
- `server.js`
- `contractAnalyzer.js`
- `lib/`
- `getTokenAbi.json`
- `tokenabi.json`
- `index.html`
- `package.json`
- `package-lock.json`
- `export.txt`

说明：

- `export.txt` 是函数签名词典，体积约 100MB，`contractAnalyzer.js` 初始化时会加载它。
- 生产环境原始 `.env` 没有直接迁移，已改为去敏版本 `.env.example`。
- 生产脚本中的数据库密码、RPC 地址、私有合约地址等硬编码已改为从环境变量读取。
- 新扫描入口已经支持按链启动多个独立进程，不再把所有逻辑堆在单文件里。

## 多链扫描设计

### 1. 启动模型

现在推荐的启动模型不是直接手工跑多个散乱脚本，而是：

1. 每个链一个 `scan-worker`
2. 每个 worker 只负责一条链
3. 用 `PM2 ecosystem` 统一拉起、重启、观察日志
4. API 服务与扫描任务解耦，是否带后台扫描由环境变量控制

`ecosystem.config.js` 会按 `SCAN_CHAINS` 生成多个应用，例如：

- `token-scan-bsc`
- `token-scan-eth`
- `token-scan-arb`

### 2. 链配置

每条链在 `src/config/chains.js` 中定义以下内容：

- `chainId`
- `rpc.http`
- `rpc.ws`
- `provider`
- `db`
- `scan.targets`

`scan.targets` 是扫描目标列表。当前默认来源是 `ave_liquidity_v1`，不再依赖链上私有合约；旧的 `private_contract_v1` 仍保留为兼容模式。

Ave 模式每个链主要配置：

- `chainId`
- `db`
- `scan.sourceType=ave_liquidity_v1`
- `scan.targets[].batchSize`
- `*_TOKEN_ADDRESSES` 初始导入的 token 地址列表

旧私有合约模式下，一个链可以配置多个 target，每个 target 声明：

- `name`
- `dexType`
- `privateContractAddress`
- `factoryTable`
- `factoryId`
- `tokenTable`
- `quoteAssets`
- `topPoolFields`
- `routers`

这就是当前为了支持“不同链不一定只有一个核心路由”而做的核心抽象。

### 3. Ave 流动性服务模式

新的默认扫描链路是：

1. 历史 token 先通过 Dune 导出，再用 `backfill:tokens` 导入 `scan_tokens`。
2. 从独立库 `scan_tokens` 读取到期待扫 token。
3. 使用 `AveLiquidityClient` 请求 `GET /liquidity`。
4. 将 token 摘要写入 `token_liquidity`。
5. 将返回的 pairs 明细写入 `token_pairs`。
6. 成功后更新 `scan_tokens.next_scan_at`，失败后按 `RETRY_DELAY_MS` 延迟重试。
7. 实时增量先监听 Factory `PairCreated` / `PoolCreated` logs，把 pair/pool 写入 `observed_pools`。
8. worker 再监听已知 pair/pool 的 liquidity `Mint` 事件，命中后把非 quote token 延迟写入待扫队列，默认 15 分钟后查 Ave。

Compose 默认开启的 discovery source：

- ETH：Uniswap V2 `PairCreated`
- BSC：PancakeSwap V2 `PairCreated` + PancakeSwap V3 `PoolCreated`
- ARB：Uniswap V3 `PoolCreated`

实时监听只负责新增数据，默认从 worker 首次启动时的当前确认块开始，不回扫历史。每个 source 的 block offset 独立存入 `scanner_state.last_block`，例如 `bsc-pancakeswap-v2`、`bsc-pancakeswap-v3`、`eth-uniswap-v2`、`arb-uniswap-v3`。容器重启后会从 `last_block + 1` 继续扫。

每个 source 会使用两类 offset：

- `factory:<source_key>`：pair/pool 创建事件 offset。
- `liquidity:<source_key>`：liquidity `Mint` 事件 offset。

认证 key 通过环境变量 `AVE_API_KEY` 配置，不写入代码仓库。

可通过环境变量一次性导入初始 token：

```bash
BSC_TOKEN_ADDRESSES=0x...,0x...
ETH_TOKEN_ADDRESSES=0x...,0x...
ARB_TOKEN_ADDRESSES=0x...,0x...
```

Dune 导出的历史 token 可以用脚本导入并 backfill：

```bash
npm run backfill:tokens -- --chain BSC --file ./bsc.csv --token-field contract_address --source dune --limit 1000 --batch-size 50 --qps 50 --concurrency 50
```

常用参数：

- `--import-only`：只导入 `scan_tokens`，不查 Ave。
- `--backfill-only`：只补已有 `scan_tokens` 的 Ave 流动性详情。
- `--import-limit 10000`：只导入前 10000 个有效 token，适合试灌；默认 `0` 表示不限制。
- `--import-batch-size 5000`：历史 CSV 流式读取后每批写入 `scan_tokens` 的数量。
- `--limit 0`：backfill 全量待补 token；默认只补 `100` 个，避免误触发超大批量。
- `--qps 50 --qpm 3000`：限制 Ave 请求启动速率，每秒最多 50 次、每分钟最多 3000 次。
- `--concurrency 50`：并发处理 token 数；请求仍会经过 QPS/QPM 限流。
- `--missing-liquidity`：使用旧的缺失流动性反查模式，适合补漏/重试；历史首轮回填默认走 `last_scanned_at IS NULL` 快速路径。
- `--force`：已存在 `token_liquidity` 的 token 也重新查。
- `--delay-ms 86400000`：导入后延迟一天再进入待扫队列。

Dune 导出的通用合约资产可以导入 `contract_assets`，这张表独立于 ERC20 的 `scan_tokens` / `token_liquidity`：

```bash
npm run import:contracts -- --chain BSC --file ../../data/bsc.csv --address-field contract_address --source dune --dataset bsc-valuable-contracts
```

导入逻辑会自动识别 `contract_address`、`address`、`target_address`、`token_address` 等常见地址字段，并把导出原始行写入 `raw_json`，把数值型字段写入 `metrics_json`。通用列只保留链、地址、来源、评分、活动时间和 `is_known_token`，所以后续 Dune 导出字段变化时不需要改表。

如果只想把非 ERC20 / 非已知 token 资产写入这张表，可以加：

```bash
npm run import:contracts -- --chain BSC --file ../../data/bsc.csv --non-token-only
```

过滤 Dune 历史 token 中的 CAKE LP / Pancake LPs：

```bash
npm run filter:scan-tokens -- --chain BSC --file ./bsc.csv --batch-size 5000
```

命中的 token 会在 `scan_tokens` 里标记为 `enabled=0,last_status='ignored'`，后续 backfill 和 worker 不会继续扫描。Ave 增量扫描也会在返回 token 元信息后过滤 CAKE LP，不写入 `token_liquidity` / `token_pairs`。

也可以直接往独立数据库插入：

```sql
INSERT INTO scan_tokens (chain_name, chain_id, token_address, source)
VALUES ('BSC', 56, LOWER('0x...'), 'manual')
ON DUPLICATE KEY UPDATE enabled = 1;
```

### 4. Docker Compose 部署

```bash
cd tools/token-db-manager-js
cp .env.example .env
# 编辑 .env，填写 AVE_API_KEY；需要改起始块/RPC 时也在这里改
npm run docker:up
```

`docker-compose.yml` 默认会启动：

- `mysql`：独立 MySQL，默认库名 `ave_scanner`
- `scan-bsc`：BSC worker
- `scan-eth`：Ethereum worker
- `scan-arb`：Arbitrum worker

每个 worker 是独立进程，只负责自己的 `CHAIN_NAME`。

默认会持续运行：每轮先扫实时新增 pair/pool，再扫 liquidity `Mint` 触发 token 延迟待扫，然后处理所有到期 token 直到队列空，再按 `GET_TOKEN_INTERVAL` 等待下一轮。

扫描 worker 镜像会通过 GitHub Actions 构建并推送到 GHCR：

```text
ghcr.io/chainsawteam/lora-token-scanner
```

当前分支推送会生成分支 tag 和 `sha-*` tag；合并到默认分支后会额外生成 `latest`。

### 5. Dry-Run 模式

现在支持 `SCAN_DRY_RUN=1`。

它的行为是：

1. 会请求 Ave 服务
2. 会打印 pairs 数量和主池 TVL
3. 不写入 `token_liquidity`
4. 不写入 `token_pairs`
5. 不更新 `scan_tokens`

因此它适合拿来验证：

- `AVE_API_KEY` 是否可用
- Ave 服务是否可达
- token 地址和 chainId 是否匹配
- 多链 worker 配置是否正确

### 6. 数据源配置

当前默认流动性数据源是 Ave 服务，不需要配置私有合约。历史 token 通过 Dune 导入；新增 token 发现按链配置 Factory logs 监听。旧的链上私有合约扫描仍可通过 `SCAN_SOURCE=private_contract_v1` 临时启用。

### 7. 方法调用监听

worker 可以额外监听新区块里的指定方法调用。命中配置的 selector 后，会检查被调用合约本身持有的原生币和 quote token 余额；估算总价值达到门槛后，提交 LORAI 审计。BSC / ETH / Base / ARB 默认启用，默认会从内置敏感方法签名库生成 selector。

```bash
BSC_METHOD_CALL_MONITOR_ENABLED=1
BSC_METHOD_CALL_SUBSCRIBE_ENABLED=1
BSC_METHOD_CALL_TRIGGER_AUDIT=0
BSC_METHOD_CALL_SELECTORS=
BSC_METHOD_CALL_USE_DEFAULT_SIGNATURES=1
BSC_METHOD_CALL_SIGNATURES=
BSC_METHOD_CALL_DENYLIST=
BSC_METHOD_CALL_SKIP_OBSERVED_POOLS=1
BSC_METHOD_CALL_SKIP_ERC20_LIKE_TARGETS=1
BSC_METHOD_CALL_MIN_VALUE_USD=40000
BSC_METHOD_CALL_COOLDOWN_MS=86400000
BSC_METHOD_CALL_MAX_TX_PER_BLOCK=2000
BSC_METHOD_CALL_MAX_CONCURRENT_BLOCKS=8
BSC_METHOD_CALL_MAX_CONCURRENT_TX=8
BSC_METHOD_CALL_MAX_QUEUED_BLOCKS=1000
BSC_METHOD_CALL_RPC_TIMEOUT_MS=10000
```

内置敏感方法签名库覆盖资金进入、迁移/升级、管理员/配置变化这几类常见入口，并枚举了常见参数重载，例如 `stake(uint256,uint256)`、`stake(address,uint256,bool)`、`deposit(uint256,address,bool)`、`migrate(address,uint256,address)`、`upgradeToAndCall(address,bytes,bool)`、`setStrategy(address,uint256,bool)` 等。`claim` / `claimReward` / `getReward` / `harvest` 这类收益领取方法，`withdraw` / `withdrawETH` / `withdrawToken` / `redeem` / `unstake` 这类提现退出方法，以及流动性类和授权托管类方法默认不包含，避免大量命中低价值领取、退出行为、LP、Router 和 ERC20。

method-call 默认会过滤掉 denylist、已观测池子和 ERC20-like 目标。BSC 默认 denylist 包含系统地址、核心 quote token、Pancake router / factory / 常见 pool 地址，避免 `deposit()` / `withdraw()` 误命中 WBNB、系统合约或 LP。

`BSC_METHOD_CALL_SIGNATURES` 支持追加自定义函数签名，worker 会自动计算 selector：

```bash
BSC_METHOD_CALL_SIGNATURES=stakeLocked(uint256,uint256),migratePosition(uint256,address)
```

`BSC_METHOD_CALL_SELECTORS` 仍支持手工追加 selector，格式是 `selector:name`，例如：

```bash
BSC_METHOD_CALL_SELECTORS=0x3a4b66f1:stake,0xa694fc3a:stake(uint256)
```

BSC 默认估值资产包括：

- BNB 原生余额
- WBNB
- USDT
- BUSD
- USDC

BNB/WBNB 美元价格默认从 PancakeSwap V2 的 WBNB/USDT 池读取；如果链上查询失败，可以用 `BSC_METHOD_CALL_NATIVE_USD_PRICE` 配置兜底价格。`BSC_METHOD_CALL_QUOTE_TOKENS` 可以覆盖 quote token 列表，格式是 `address:symbol:decimals:priceUsd`。

ETH 默认估值资产包括 ETH、WETH、USDT、USDC、DAI。ETH/WETH 美元价格默认从 Ethereum 主网 Chainlink ETH/USD feed 读取；如果链上查询失败，可以用 `ETH_METHOD_CALL_NATIVE_USD_PRICE` 配置兜底价格。

Base 默认估值资产包括 ETH、WETH、USDC、USDbC、DAI。ETH/WETH 美元价格默认从 Base 的 Chainlink ETH/USD feed 读取；如果链上查询失败，可以用 `BASE_METHOD_CALL_NATIVE_USD_PRICE` 配置兜底价格。

ARB 默认估值资产包括 ETH、WETH、USDC、USDC.e、USDT、DAI。ETH/WETH 美元价格默认从 Arbitrum 的 Chainlink ETH/USD feed 读取；如果链上查询失败，可以用 `ARB_METHOD_CALL_NATIVE_USD_PRICE` 配置兜底价格。

该监听只处理新块订阅，不回扫历史交易；新区块会进入内存队列并按配置并发处理，`*_METHOD_CALL_MAX_QUEUED_BLOCKS` 用来限制 worker 落后时最多保留多少个待处理块。同一个目标合约默认 24 小时内只尝试触发一次 LORAI，避免热门合约反复提交。

method-call 使用有上限的并发处理：`*_METHOD_CALL_MAX_CONCURRENT_BLOCKS` 控制同时处理多少个新区块，`*_METHOD_CALL_MAX_CONCURRENT_TX` 控制同一个区块里命中敏感方法的交易并发数。`*_METHOD_CALL_RPC_TIMEOUT_MS` 会给 full block 拉取和后续 `eth_call/getCode/getBalance` 设置超时，避免单个 RPC 卡住导致整个队列不再消费。

如果某条链只想处理 worker 启动后的增量，不处理数据库里已有的待扫队列，可以开启 `*_SKIP_EXISTING_DUE_TOKENS=1`。ETH / Base / ARB 的 Compose 默认已开启该模式，并且 `*_DISCOVERY_BACKFILL_ENABLED=0`，所以不会回扫历史日志，也不会消费启动前遗留的 due token。

### 8. 合约核心资产观测

BSC worker 可以订阅新区块并观测所有带 calldata 的交易。worker 会按块去重 `tx.to`，检查被调用合约持有的核心资产余额；命中阈值后先只打印 `contract-value OBSERVE` 日志，默认不提交 LORAI、不写扫描队列。

```bash
BSC_CONTRACT_VALUE_MONITOR_ENABLED=1
BSC_CONTRACT_VALUE_MONITOR_SUBSCRIBE_ENABLED=1
BSC_CONTRACT_VALUE_MONITOR_TRIGGER_SCAN=0
BSC_CONTRACT_VALUE_MONITOR_MIN_TOTAL_USD=20000
BSC_CONTRACT_VALUE_MONITOR_NATIVE_MIN_AMOUNT=100
BSC_CONTRACT_VALUE_MONITOR_SKIP_OBSERVED_POOLS=1
BSC_CONTRACT_VALUE_MONITOR_SKIP_ERC20_LIKE_TARGETS=1
BSC_CONTRACT_VALUE_MONITOR_COMBO_MIN_ASSET_COUNT=3
BSC_CONTRACT_VALUE_MONITOR_COMBO_MIN_TOTAL_USD=100000
BSC_CONTRACT_VALUE_MONITOR_SINGLE_MIN_VALUE_USD=100000
BSC_CONTRACT_VALUE_MONITOR_COOLDOWN_MS=600000
BSC_CONTRACT_VALUE_MONITOR_MAX_CONTRACTS_PER_BLOCK=200
BSC_CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_CONTRACTS=10
```

BSC 默认核心资产阈值：

- 多资产组合：至少 3 种核心资产，合计美元价值 `>= 100000`
- 单资产大额：任意单个核心资产美元价值 `>= 100000`
- BNB：余额 `>= 100`
- WBNB：余额 `>= 100`

BSC 默认压缩规则：

- 核心资产合约、Pancake 路由/工厂、系统地址等 denylist 直接跳过。
- `observed_pools` 中已经记录过的池子地址直接跳过。
- 目标合约如果看起来是 ERC20 token 合约，直接跳过。
- 普通 2 万 U 总额不再直接命中，避免每块大量常见业务合约进入候选。

`BSC_CONTRACT_VALUE_MONITOR_ASSETS` 可以覆盖 ERC20 核心资产列表，格式是 `address:symbol:decimals:priceUsd:minAmount:minValueUsd`。如果资产价格跟原生币相同，`priceUsd` 可以写 `native`，例如：

```bash
BSC_CONTRACT_VALUE_MONITOR_ASSETS=0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c:WBNB:18:native:20:0,0x55d398326f99059ff775485246999027b3197955:USDT:18:1:0:20000
```

为了控制 RPC 压力，观测只处理每块前 `BSC_CONTRACT_VALUE_MONITOR_MAX_TX_PER_BLOCK` 笔交易，最多检查 `BSC_CONTRACT_VALUE_MONITOR_MAX_CONTRACTS_PER_BLOCK` 个唯一合约，并用 `BSC_CONTRACT_VALUE_MONITOR_MAX_CONCURRENT_CONTRACTS` 控制并发估值。每块 summary 会打印 `qualified` 频率和 `skippedDenylist/skippedPool/skippedErc20/skippedStructure`；详细 `OBSERVE target=...` 日志默认对同一合约 10 分钟冷却一次，设置 `BSC_CONTRACT_VALUE_MONITOR_COOLDOWN_MS=0` 可以看全量明细。`BSC_CONTRACT_VALUE_MONITOR_TRIGGER_SCAN=1` 之后才会把命中合约提交给 LORAI；试点阶段保持 `0` 即只观测频率。

## Token 入库逻辑

### 1. 数据来源

`getToken.js` / `getTokenCode.js` 现在作为兼容入口启动 `src/apps/scan-worker.js`。默认数据来源是 Ave 流动性服务，而不是链上 `getToken(index)` 合约。

整体流程：

1. 从 `scan_tokens` 表读取到期待扫 token。
2. 调用 `AveLiquidityClient.getLiquidity({ chainId, tokenAddress })`。
3. 将 token 摘要写入 `token_liquidity`。
4. 将交易对列表写入 `token_pairs`。
5. 成功后更新 `scan_tokens.next_scan_at`。

### 2. 写入字段

当前写入 `token_liquidity` 的主要字段如下：

- `chain_name` / `chain_id`
- `token_address`
- `name` / `symbol`
- `holders`
- `current_price_usd`
- `risk_level`
- `main_pair`
- `main_pair_tvl`
- `is_audited`
- `resolved_pair`
- `pairs_count`
- `raw_json`

当前写入 `token_pairs` 的主要字段如下：

- `pair_address`
- `amm`
- `token0_address` / `token1_address`
- `reserve0` / `reserve1`
- `token0_price_usd` / `token1_price_usd`
- `volume_u_24h`
- `tx_24h_count`
- `lp_holders`
- `lp_locked_percent`
- `raw_json`

### 3. 增量更新逻辑

新结构下，扫描编排在 `TokenScannerService` 中，Ave 访问封装在：

- `src/lib/aveLiquidityClient.js`
- `src/adapters/aveLiquidityTokenSource.js`

worker 会按 `GET_TOKEN_INTERVAL` 周期拉取到期待扫 token；每个 token 的下一次扫描时间由 `RESCAN_INTERVAL_MS` 控制。

默认使用精简持久化（`PERSIST_LIQUIDITY_DETAILS=0`）：只保存 token 地址、流动性、扫描状态和时间，pairs 仅用于本次阈值判断，不写入 `token_pairs`。只有确实需要调试完整 Ave 快照时才临时设置 `PERSIST_LIQUIDITY_DETAILS=1`。默认兜底重扫周期为 7 天；Lorai 返回已有审计或成功提交后，该 token 会退出周期调度，后续新的链上流动性事件仍可重新触发检查。

## HTTP 服务逻辑

原来的 `server.js` 是旧版 Node 服务入口，包含两类职责：

1. 提供 Token 数据查询 API
   例如 Token 列表、统计信息等。
2. 启动与 `getToken.js` 类似的后台任务
   包括新增 Token 抓取、旧 Token 更新、Top Pool 更新。

此外它还会连接 `lora` 数据库，为通知与合约查询提供接口。新的 Ave worker 不依赖这部分。

现在已经完成第一步拆分：

- 采集 Worker
- API 服务入口 `src/apps/api-server.js`
- 旧 `server.js` 仅保留兼容包装

## 多链合约分析逻辑

`contractAnalyzer.js` 与 `lib/` 这一套是另一条能力线，主要针对 `lora.new_contracts` 表，而不是 `token.Token` 表。

其流程大致如下：

1. 读取 `export.txt`，建立函数签名索引。
2. 初始化多链 RPC 连接。
3. 从 `lora.new_contracts` 取待分析合约。
4. 拉取链上字节码并解析函数选择器。
5. 判断是否代理合约，并尝试定位实现合约。
6. 对函数做 Fuzz 测试。
7. 将分析结果写回数据库。

这部分本身已经具备多链雏形，支持范围明显大于旧版 Token 入库脚本。

## 现状判断

从实现边界看，生产目录实际混合了两套不同成熟度的代码：

1. Token 采集链路
   已切到 Ave 服务和独立 MySQL 表，旧私有合约路径仅保留兼容。
2. Contract Analyzer 链路
   已有多链意识，也更接近可继续演化的基础模块。

因此“支持多链 Token 和高价值合约获取”这件事，不能只把 `getToken.js` 参数化就结束，后续大概率还需要：

- 为不同链定义独立的数据源适配器
- 解耦 `WBNB/USDT/BUSD` 这类 BSC 专属字段
- 统一价值口径
- 明确 Token、合约、池子三类实体的关系

## 本次迁移后的建议入口

### BSC Flap Vault Factory 监听

BSC Worker 支持订阅 Flap `vaultPortal` 的 `FlapTaxVaultFactoryRegistered(address,bool,bool,uint8)` 事件。事件触发后会将 `factory` 地址提交到 LORAI 审计队列。

默认配置：

```env
BSC_FLAP_VAULT_FACTORY_MONITOR_ENABLED=1
BSC_FLAP_VAULT_FACTORY_SUBSCRIBE_ENABLED=1
BSC_FLAP_VAULT_FACTORY_TRIGGER_AUDIT=1
BSC_FLAP_VAULT_FACTORY_BACKFILL_ENABLED=0
BSC_FLAP_VAULT_PORTAL_ADDRESS=0x90497450f2a706f1951b5bdda52B4E5d16f34C06
```

默认只监听增量，不回扫历史日志。

如果只是先理解和跑通新结构，建议按下面顺序：

1. 复制 `.env.example` 为本地 `.env` 并填入 `AVE_API_KEY`
2. 导入 Dune 历史 token：`npm run backfill:tokens -- --chain BSC --file ./bsc.csv --token-field contract_address --source dune --import-only`
3. 补历史流动性详情：`npm run backfill:tokens -- --chain BSC --backfill-only --source dune --limit 1000 --qps 50 --concurrency 50`
4. 容器启动实时增量：`npm run docker:up`
5. 查看日志：`npm run docker:logs`
6. 单链本地调试：`npm run scan:bsc`
7. 多链合约分析：`node contractAnalyzer.js analyze --chain BSC`

## 后续建议

建议后续分三步治理：

1. 为 `scan_tokens` 增加上游写入入口，例如从新合约监听服务或后台 API 导入 token
2. 再把 Token 抓取与合约分析拆成两个独立 package
3. 为 `token_liquidity` / `token_pairs` 增加查询 API 或后台管理页

当前目录的定位是“生产逻辑迁移基线”，不是最终架构形态。
