#!/usr/bin/env node

const { getChainConfig } = require('../config/runtime');
const { getServerConfig } = require('../config/server');
const createPool = require('../db/createPool');
const createWeb3Client = require('../lib/createWeb3Client');
const TokenRepository = require('../repositories/tokenRepository');
const LoraRepository = require('../repositories/loraRepository');
const TokenScannerService = require('../services/tokenScannerService');
const createApp = require('../api/createApp');

async function main() {
  const chainConfig = getChainConfig(process.env.CHAIN_NAME || 'BSC');
  const serverConfig = getServerConfig();
  const tokenPool = createPool(chainConfig.db);
  const tokenRepository = new TokenRepository(tokenPool);
  const loraPool = createPool({
    host: process.env.LORA_DB_HOST || process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.LORA_DB_PORT || process.env.DB_PORT || '3306', 10),
    user: process.env.LORA_DB_USER || process.env.DB_USER || 'root',
    password: process.env.LORA_DB_PASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.LORA_DB_NAME || 'lora'
  });
  const loraRepository = new LoraRepository(loraPool);
  const web3 = chainConfig.scan.sourceType === 'ave_liquidity_v1' && !chainConfig.scan.discovery?.enabled
    ? null
    : createWeb3Client(chainConfig);
  const scannerService = new TokenScannerService({
    chainConfig,
    web3,
    repository: tokenRepository,
    dryRun: serverConfig.dryRun
  });

  await tokenRepository.testConnection();
  await loraRepository.testConnection();

  const tokenTable = chainConfig.scan.targets[0].tokenTable;
  const app = createApp({
    tokenRepository,
    tokenTable,
    loraRepository,
    serverConfig,
    chainConfig
  });

  const server = app.listen(serverConfig.port, async () => {
    console.log(`🚀 API 服务运行在 http://localhost:${serverConfig.port}`);
    console.log(`🔗 chain=${chainConfig.key} token_db=${chainConfig.db.database} token_table=${tokenTable}`);
    console.log(`🧪 dryRun=${serverConfig.dryRun} backgroundTasks=${serverConfig.enableBackgroundTasks}`);

    if (serverConfig.enableBackgroundTasks) {
      await scannerService.start();
    }
  });

  const shutdown = async signal => {
    console.log(`收到${signal}信号，正在关闭服务器...`);
    await tokenPool.end();
    await loraPool.end();
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(`[api-server] 启动失败: ${error.message}`);
  process.exit(1);
});
