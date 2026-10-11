# token-db-manager-js 当前架构说明

## 1. 目标

这份文档描述的是 `tools/token-db-manager-js` 目录在当前阶段的实际可运行架构，不再强调“从生产机搬迁过来”的历史背景，而是聚焦以下几个问题：

1. 这套代码现在是怎么组织的
2. 扫描任务和 API 服务分别由谁负责
3. 多链配置是怎么落地的
4. `dry-run` 模式到底做什么、不做什么
5. 后续如果要继续扩展，应该从哪里下手

## 2. 当前目录结构

```text
tools/token-db-manager-js/
├── ecosystem.config.js
├── src/
│   ├── adapters/
│   │   └── privateContractTokenSource.js
│   ├── api/
│   │   └── createApp.js
│   ├── apps/
│   │   ├── api-server.js
│   │   └── scan-worker.js
│   ├── config/
│   │   ├── chains.js
│   │   ├── runtime.js
│   │   └── server.js
│   ├── db/
│   │   └── createPool.js
│   ├── lib/
│   │   └── createWeb3Client.js
│   ├── repositories/
│   │   ├── loraRepository.js
│   │   └── tokenRepository.js
│   └── services/
│       └── tokenScannerService.js
├── contractAnalyzer.js
├── getToken.js
├── getTokenCode.js
├── server.js
├── .env.example
└── README.zh-CN.md
```

## 3. 架构分层

当前实现已经从“单文件堆逻辑”改成了按职责分层：

### 3.1 apps

`src/apps/` 是进程级入口。

- `scan-worker.js`
  单链扫描进程入口
- `api-server.js`
  API 服务入口，可选附带后台扫描

这两个入口是当前最主要的运行方式。

### 3.2 config

`src/config/` 负责把静态定义和环境变量拼起来。

- `chains.js`
  定义链级配置
- `runtime.js`
  负责解析 `CHAIN_NAME`、`SCAN_CHAINS`
- `server.js`
  负责 API 服务相关配置，例如端口、是否启用后台任务、是否 `dry-run`

### 3.3 repositories

`src/repositories/` 负责数据库读写，不直接关心链上逻辑。

- `tokenRepository.js`
  面向 Token 库，处理 `Factory` / `Token` 表
- `loraRepository.js`
  面向 `lora` 库，处理 `notifications`、`new_contracts`、`contract_functions`

### 3.4 adapters

`src/adapters/` 负责“数据源适配”。

当前只有一个：

- `privateContractTokenSource.js`

它对应的是当前历史逻辑里最核心的一类来源：

1. 先从数据库读取 `Factory`
2. 再调用私有合约 `getToken(index)`
3. 获取 Token 池子的聚合结果
4. 转成统一 payload

后续如果要支持：

- 直接扫 Uniswap V2 Factory
- 扫 V3 Pool
- 扫其他 DEX 体系

应该继续往 `adapters/` 里新增，而不是回到入口文件里写死。

### 3.5 services

`src/services/tokenScannerService.js` 是扫描编排层。

它不直接写 SQL，也不直接定义链配置，而是调度：

- repository
- adapter
- web3 client

目前它负责三类周期任务：

1. 新增扫描
2. 旧数据刷新
3. Top Pool 刷新

如果开启 `dry-run`，只保留第一类。

### 3.6 api

`src/api/createApp.js` 负责 Express 应用组装。

它把下面几类接口统一挂到一个服务里：

- Token API
- Notifications API
- Contracts API
- Health API

这层只做 HTTP 协议和参数校验，不直接承担底层扫描逻辑。

## 4. 扫描模型

### 4.1 单链单进程

当前推荐模型是“每条链一个 worker 进程”。

也就是说：

- `BSC` 一个 worker
- `ETH` 一个 worker
- `ARB` 一个 worker

这样做的好处是：

1. 每条链的 RPC 故障不会直接拖死别的链
2. 日志和排障可以按链分开看
3. 配置粒度清晰，不会所有链共享同一套运行态

### 4.2 PM2 管理

`ecosystem.config.js` 会根据 `SCAN_CHAINS` 生成多个 PM2 app。

例如：

- `SCAN_CHAINS=BSC`
- `SCAN_CHAINS=BSC,ETH,ARB`

这样 PM2 启动时会自动生成多个扫描进程。

### 4.3 链配置驱动

每条链的配置位于 `src/config/chains.js`。

当前每条链主要包含：

- `chainId`
- `provider`
- `rpc.http`
- `rpc.ws`
- `db`
- `scan`

其中 `scan.targets` 是关键设计点。

每个 target 可以单独声明：

- `name`
- `dexType`
- `privateContractAddress`
- `factoryTable`
- `tokenTable`
- `factoryId`
- `quoteAssets`
- `topPoolFields`
- `routers`

这意味着一个链并不被限制为只有一个 DEX。

## 5. 当前支持的数据来源

当前真正已经落地的扫描来源只有一种：

- `private_contract_v1`

它依赖：

1. 一张 `Factory` 表
2. 一张 `Token` 表
3. 一个支持 `getToken(index)` 的私有合约

因此现在的“多链支持”是结构上成立的，但业务上能不能真正扫起来，要看对应链是否已经具备这三样东西。

如果某条链没有对应的：

- 私有合约
- `Factory` 表
- `Token` 表

那么它虽然能配置进来，但不能真正完成扫描。

## 6. dry-run 模式

### 6.1 目的

`dry-run` 的作用不是做完整模拟，而是验证“新增扫描链路本身是否通”。

### 6.2 行为定义

开启方式：

- `SCAN_DRY_RUN=1`

开启后：

1. 会读取数据库中的 `Factory`
2. 会读取链上的 `allPairsLength()`
3. 会调用私有合约 `getToken(index)`
4. 会计算 payload
5. 会把结果打印到日志

但不会：

1. 写入 `Token` 表
2. 更新 `Factory.PickIndex`
3. 执行旧数据刷新
4. 执行 Top Pool 刷新

### 6.3 适用场景

适合拿来验证：

1. RPC 是否通
2. 数据库是否能读到 `Factory`
3. 私有合约地址是否正确
4. 链配置是否匹配
5. 某条新链接入时最小链路是否跑通

不适合拿来验证：

1. 实际入库结果
2. 增量推进是否正确
3. `Factory.PickIndex` 是否会持续更新

## 7. API 服务模型

### 7.1 服务入口

API 服务入口是：

- `src/apps/api-server.js`

兼容入口是：

- `server.js`

`server.js` 现在只是一个薄包装，不再承载主逻辑。

### 7.2 API 与扫描解耦

API 服务默认不自动开启扫描。

这是刻意做的，因为“提供查询接口”和“执行链上扫描”本质上是两种不同职责。

通过环境变量可以控制：

- 只开 API
- API + 后台扫描
- API + `dry-run` 后台扫描

### 7.3 当前接口范围

当前 API 主要覆盖：

- `/api/tokens`
- `/api/stats`
- `/api/notifications`
- `/api/contracts`
- `/api/health`

也就是说，当前已经把原来旧 `server.js` 的主要接口能力迁到了新结构里。

## 8. 运行方式

### 8.1 扫描 worker

单链正常扫描：

```bash
npm run scan:bsc
```

单链 dry-run：

```bash
npm run scan:bsc:dry
```

### 8.2 API 服务

只启动 API：

```bash
npm run api:start
```

API + 后台扫描：

```bash
npm run api:with-scan
```

API + dry-run 扫描：

```bash
npm run api:with-scan:dry
```

### 8.3 PM2

多链扫描：

```bash
npm run pm2:start
```

重载配置：

```bash
npm run pm2:reload
```

## 9. 当前限制

这版结构已经比旧脚本清晰很多，但还有几个现实限制：

### 9.1 仍然依赖历史表结构

扫描逻辑仍然默认依赖 `Factory` / `Token` 这套历史表设计。

这意味着：

- 结构已经多链化
- 但数据模型还没有真正链无关化

### 9.2 quote 字段仍带历史痕迹

虽然已经抽成配置，但底层表字段仍可能是：

- `WBNB`
- `USDT`
- `BUSD`

其他链如果想完全自然地支持：

- `WETH`
- `USDC`
- 其他稳定币或基础资产

最终还是需要进一步统一表设计。

### 9.3 目前只有一种 adapter

当前只有 `privateContractTokenSource`。

如果未来要支持：

- 直接扫 DEX Factory
- V3 Pool
- 非 Uniswap 系 DEX

必须继续补新的 adapter。

## 10. 建议的后续演进

建议按下面顺序继续推进：

1. 先确认 BSC / ETH / ARB 哪些链已经真实具备私有合约和对应表结构
2. 把每条链的真实配置补齐并做 `dry-run` 验证
3. 为新来源引入第二种 adapter，而不是继续扩展 `private_contract_v1`
4. 再考虑统一 Token / Pool / Quote Asset 的表结构

## 11. 总结

当前这套代码已经从“遗留脚本集合”变成了“可配置的多链扫描骨架”。

它现在具备的核心能力是：

1. 单链单进程扫描
2. PM2 多链并行启动
3. 链级配置驱动
4. API 与扫描解耦
5. `dry-run` 新增扫描验证

它还不是最终形态，但已经足够作为下一阶段继续开发的基线。
