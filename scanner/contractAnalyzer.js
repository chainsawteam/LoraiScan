require('dotenv').config();
const mysql = require('mysql2/promise');
const http = require('http');
const url = require('url');

// 导入自定义模块
const SignatureLoader = require('./lib/signatureLoader');
const Web3Manager = require('./lib/web3Manager');
const DBManager = require('./lib/dbManager');
const ContractAnalyzer = require('./lib/contractAnalyzer');
const FunctionFuzzer = require('./lib/functionFuzzer');

// ==================== CLI 参数解析 ====================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    command: 'server',
    chain: null,
    limit: '100',
    port: process.env.HTTP_PORT || 3089
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'analyze' || arg === 'test' || arg === 'stats' || arg === 'help' || arg === 'server') {
      options.command = arg;
    } else if (arg === '--chain' || arg === '-c') {
      options.chain = args[++i];
    } else if (arg === '--limit' || arg === '-l') {
      options.limit = args[++i];
    } else if (arg === '--port' || arg === '-p') {
      options.port = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    }
  }

  return options;
}

function showHelp() {
  console.log(`
🔍 合约字节码分析和 Fuzz 测试工具

使用方法:
  node contractAnalyzer.js [command] [options]

命令:
  analyze    分析待处理的合约（默认）
  test       测试所有链的 RPC 连接
  stats      显示统计信息
  server     启动 HTTP API 服务
  help       显示帮助信息

选项:
  -c, --chain <chain>        只分析指定链 (BSC/ETH/ARB)
  -l, --limit <number>       限制分析数量（默认: 100）
  -p, --port <number>        HTTP 服务端口（默认: 3000）
  -h, --help                 显示帮助信息

示例:
  node contractAnalyzer.js                    # 分析所有链的待处理合约
  node contractAnalyzer.js analyze            # 同上（显式指定命令）
  node contractAnalyzer.js -c BSC             # 只分析 BSC 链
  node contractAnalyzer.js -c ETH -l 50       # 只分析 ETH 链，最多 50 个
  node contractAnalyzer.js test               # 测试 RPC 连接
  node contractAnalyzer.js stats              # 显示统计信息
  node contractAnalyzer.js server             # 启动 HTTP API 服务（端口 3000）
  node contractAnalyzer.js server -p 8080     # 启动 HTTP API 服务（端口 8080）

说明:
  - 该工具会分析 lora.new_contracts 表中状态为 'pending' 的合约
  - 使用 evmole 提取函数选择器和参数信息
  - 对每个函数进行 Fuzz 测试调用
  - 将分析结果保存到数据库
  - 支持 BSC、ETH、ARB、POLYGON、FTM、AVAX、OPTIMISM、BASE 等多条链
  - HTTP API 提供 /api/contracts/:id/analyze 接口供网页调用
`);
}

// ==================== 配置 ====================

// Lora 数据库连接池
const loraPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: 'lora',
  port: process.env.DB_PORT || 3306,
  charset: 'utf8mb4',
  timezone: '+08:00',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 全局实例
let signatureLoader;
let web3Manager;
let db;
let analyzer;
let fuzzer;

// ==================== 初始化 ====================

/**
 * 初始化所有模块
 */
async function initialize() {
  console.log('🚀 合约分析服务启动中...\n');

  // 1. 加载函数签名
  signatureLoader = new SignatureLoader();
  await signatureLoader.load('./export.txt');
  console.log('');

  // 2. 初始化 Web3 多链管理
  web3Manager = new Web3Manager();
  console.log('');

  // 3. 测试数据库连接
  db = new DBManager(loraPool);
  const dbConnected = await db.testConnection();
  if (dbConnected) {
    console.log('✅ 数据库连接正常\n');
  } else {
    console.error('❌ 数据库连接失败');
    process.exit(1);
  }

  // 4. 初始化分析器和 Fuzzer
  analyzer = new ContractAnalyzer(web3Manager, signatureLoader);
  fuzzer = new FunctionFuzzer(web3Manager, signatureLoader);

  console.log('✅ 所有模块初始化完成\n');
}

// ==================== 主流程 ====================

/**
 * 主分析流程
 * @param {Object} options - 命令行选项
 */
async function main(options) {
  try {
    // 显示统计信息
    const stats = await db.getStats();
    console.log('📊 数据库统计:');
    console.log(`   总合约数: ${stats.total}`);
    console.log(`   待分析: ${stats.pending}`);
    console.log(`   已分析: ${stats.analyzed}`);
    console.log(`   无效: ${stats.invalid}`);
    console.log('');

    // 获取待分析合约
    console.log(`🔍 正在获取待分析合约...`);
    console.log(`   链筛选: ${options.chain || '全部'}`);
    console.log(`   数量限制: ${options.limit}`);
    console.log('');

    const pendingContracts = await db.getPendingContracts(options.chain, parseInt(options.limit));

    if (pendingContracts.length === 0) {
      console.log('✅ 没有待分析的合约');
      process.exit(0);
    }

    console.log(`📋 找到 ${pendingContracts.length} 个待分析合约\n`);
    console.log('='.repeat(80));

    // 逐个分析合约
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < pendingContracts.length; i++) {
      const contract = pendingContracts[i];
      const index = i + 1;

      console.log(`\n📝 [${index}/${pendingContracts.length}] 分析合约 #${contract.id}`);
      console.log(`   地址: ${contract.contract_address}`);
      console.log(`   链: ${contract.chain_name}`);
      console.log(`   部署者: ${contract.deployer_address || '未知'}`);

      try {
        // 1. 分析函数
        const analysisResult = await analyzer.analyze(contract);

        if (!analysisResult.success) {
          throw new Error(analysisResult.error);
        }

        const { functions, bytecode, proxyInfo } = analysisResult;

        if (functions.length === 0) {
          // 先检测是否为代理合约
          if (proxyInfo.isProxy) {
            console.log(`   🛡️ 检测到代理合约: ${proxyInfo.proxyType}`);
            console.log(`   📝 原因: ${proxyInfo.reason}`);

            // 尝试获取实现合约地址
            const implAddress = await analyzer.getImplementationAddress(
              bytecode,
              contract.contract_address,
              contract.chain_name
            );

            if (implAddress) {
              console.log(`   ✅ 找到实现合约: ${implAddress}`);

              // 分析实现合约
              console.log(`   🔍 开始分析实现合约...`);
              const implAnalysisResult = await analyzer.analyze({
                ...contract,
                contract_address: implAddress
              });

              if (implAnalysisResult.success && implAnalysisResult.functions.length > 0) {
                console.log(`   ✅ 实现合约分析完成，发现 ${implAnalysisResult.functions.length} 个函数`);

                // 保存实现合约的分析结果
                const testResults = await fuzzer.fuzzAll(contract, implAnalysisResult.functions);
                await db.saveAnalysisResult(contract.id, implAnalysisResult.functions, testResults);
                await db.markContractAnalyzed(contract.id);

                // 在备注中添加实现合约信息
                const remark = `[代理合约] ${proxyInfo.proxyType}: ${proxyInfo.reason}\n实现合约: ${implAddress}`;
                await db.pool.execute(
                  'UPDATE new_contracts SET remark = ? WHERE id = ?',
                  [remark, contract.id]
                );

                successCount++;
                continue;
              } else {
                console.log(`   ⚠️ 实现合约也无可调用函数`);
                await db.markContractInvalid(contract.id, `代理合约的实现合约无可调用函数\n实现合约: ${implAddress}`);
                failCount++;
                continue;
              }
            } else {
              console.log(`   ⚠️ 无法获取实现合约地址，标记为代理合约`);
              await db.markContractProxy(contract.id, proxyInfo.proxyType, proxyInfo.reason + ' (无法获取实现合约)');
              successCount++;
              continue;
            }
          } else {
            console.log(`   ⚠️ 未发现可调用函数，标记为无效`);
            await db.markContractInvalid(contract.id, '无可调用函数');
            failCount++;
            continue;
          }
        }

        // 2. Fuzz 测试
        console.log(`   🧪 开始 Fuzz 测试...`);
        const testResults = await fuzzer.fuzzAll(contract, functions);
        console.log(`   📊 测试结果: ${testResults.success} 成功, ${testResults.failed} 失败`);

        // 3. 保存结果
        await db.saveAnalysisResult(contract.id, functions, testResults);
        await db.markContractAnalyzed(contract.id);

        console.log(`   ✅ 分析完成`);
        successCount++;

      } catch (error) {
        console.error(`   ❌ 分析失败: ${error.message}`);
        await db.markContractInvalid(contract.id, error.message);
        failCount++;
      }

      // 添加延迟，避免 RPC 限流
      if (i < pendingContracts.length - 1) {
        console.log(`   ⏳ 等待 2 秒后继续...`);
        await sleep(2000);
      }
    }

    // 显示总结
    console.log('\n' + '='.repeat(80));
    console.log('\n📊 分析总结:');
    console.log(`   总数: ${pendingContracts.length}`);
    console.log(`   成功: ${successCount}`);
    console.log(`   失败: ${failCount}`);
    console.log(`   成功率: ${((successCount / pendingContracts.length) * 100).toFixed(2)}%`);
    console.log('\n✅ 所有合约分析完成!');

    process.exit(0);

  } catch (error) {
    console.error(`\n❌ 主流程错误: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * 延迟函数
 * @param {number} ms - 毫秒
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 测试指定链的连接
 */
async function testConnections() {
  await initialize();
  console.log('\n🔍 测试所有链的连接...\n');
  await web3Manager.testAllConnections();
  process.exit(0);
}

/**
 * 显示统计信息
 */
async function showStats() {
  await initialize();
  const stats = await db.getStats();

  console.log('\n📊 合约统计信息:');
  console.log('='.repeat(40));
  console.log(`总合约数:     ${stats.total}`);
  console.log(`待分析:       ${stats.pending}`);
  console.log(`已分析:       ${stats.analyzed}`);
  console.log(`无效:         ${stats.invalid}`);
  console.log('='.repeat(40));

  // 显示签名数据库统计
  const sigStats = signatureLoader.getStats();
  console.log('\n📖 函数签名数据库:');
  console.log('='.repeat(40));
  console.log(`选择器数量:   ${sigStats.selectors}`);
  console.log(`签名总数:     ${sigStats.totalSignatures}`);
  console.log('='.repeat(40));

  process.exit(0);
}

// ==================== HTTP API 服务 ====================

/**
 * 启动 HTTP API 服务
 * @param {Object} options - 命令行选项
 */
async function startHttpServer(options) {
  await initialize();

  const port = options.port;

  const server = http.createServer(async (req, res) => {
    // 设置 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    console.log(`${new Date().toISOString()} - ${req.method} ${pathname}`);

    // 处理 /api/contracts/:id/analyze 请求
    if (pathname.match(/^\/api\/contracts\/\d+\/analyze$/) && req.method === 'POST') {
      let contract; // 在 try 块外声明，catch 块才能访问
      try {
        const contractId = parseInt(pathname.split('/')[3]);

        // 获取合约信息
        contract = await db.getContractById(contractId);

        if (!contract) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '合约不存在' }));
          return;
        }

        console.log(`\n📝 开始分析合约 #${contract.id}`);
        console.log(`   地址: ${contract.contract_address}`);
        console.log(`   链: ${contract.chain_name}`);

        // 1. 分析函数
        const analysisResult = await analyzer.analyze(contract);

        if (!analysisResult.success) {
          throw new Error(analysisResult.error);
        }

        const { functions, bytecode, proxyInfo } = analysisResult;

        if (functions.length === 0) {
          if (proxyInfo.isProxy) {
            console.log(`   🛡️ 检测到代理合约: ${proxyInfo.proxyType}`);
            console.log(`   📝 原因: ${proxyInfo.reason}`);

            // 尝试获取实现合约地址
            const implAddress = await analyzer.getImplementationAddress(
              bytecode,
              contract.contract_address,
              contract.chain_name
            );

            if (implAddress) {
              console.log(`   ✅ 找到实现合约: ${implAddress}`);

              // 分析实现合约
              console.log(`   🔍 开始分析实现合约...`);
              const implAnalysisResult = await analyzer.analyze({
                ...contract,
                contract_address: implAddress
              });

              if (implAnalysisResult.success && implAnalysisResult.functions.length > 0) {
                console.log(`   ✅ 实现合约分析完成，发现 ${implAnalysisResult.functions.length} 个函数`);

                // 保存实现合约的分析结果
                const testResults = await fuzzer.fuzzAll(contract, implAnalysisResult.functions);
                await db.saveAnalysisResult(contract.id, implAnalysisResult.functions, testResults);
                await db.markContractAnalyzed(contract.id);

                // 在备注中添加实现合约信息
                const remark = `[代理合约] ${proxyInfo.proxyType}: ${proxyInfo.reason}\n实现合约: ${implAddress}`;
                await db.pool.execute(
                  'UPDATE new_contracts SET remark = ? WHERE id = ?',
                  [remark, contract.id]
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  message: '代理合约分析完成（已分析实现合约）',
                  contractId: contract.id,
                  data: {
                    function_count: implAnalysisResult.functions.length,
                    is_proxy: true,
                    proxy_type: proxyInfo.proxyType,
                    implementation_address: implAddress,
                    success_count: testResults.success,
                    fail_count: testResults.failed
                  }
                }));
                return;
              } else {
                console.log(`   ⚠️ 实现合约也无可调用函数`);
                await db.markContractInvalid(contract.id, `代理合约的实现合约无可调用函数\n实现合约: ${implAddress}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: false,
                  message: '实现合约也无可调用函数',
                  contractId: contract.id,
                  data: {
                    function_count: 0,
                    is_proxy: true,
                    proxy_type: proxyInfo.proxyType,
                    implementation_address: implAddress
                  }
                }));
                return;
              }
            } else {
              console.log(`   ⚠️ 无法获取实现合约地址`);
              await db.markContractProxy(contract.id, proxyInfo.proxyType, proxyInfo.reason + ' (无法获取实现合约)');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                message: '检测到代理合约（无法获取实现合约）',
                contractId: contract.id,
                data: {
                  function_count: 0,
                  is_proxy: true,
                  proxy_type: proxyInfo.proxyType
                }
              }));
              return;
            }
          } else {
            await db.markContractInvalid(contract.id, '无可调用函数');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: '标记为无效',
              contractId: contract.id,
              data: {
                function_count: 0,
                is_proxy: false
              }
            }));
            return;
          }
        }

        // 2. Fuzz 测试
        console.log(`   🧪 开始 Fuzz 测试...`);
        const testResults = await fuzzer.fuzzAll(contract, functions);
        console.log(`   📊 测试结果: ${testResults.success} 成功, ${testResults.failed} 失败`);

        // 3. 保存结果
        await db.saveAnalysisResult(contract.id, functions, testResults);
        await db.markContractAnalyzed(contract.id);

        console.log(`   ✅ 分析完成`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: '分析完成',
          contractId: contract.id,
          data: {
            function_count: functions.length,
            success_count: testResults.success,
            fail_count: testResults.failed
          }
        }));

      } catch (error) {
        console.error(`   ❌ 分析失败: ${error.message}`);
        // 标记合约为无效（如果 contract 存在）
        if (contract && contract.id) {
          await db.markContractInvalid(contract.id, error.message);
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          message: error.message,
          contractId: contract ? contract.id : null
        }));
      }
      return;
    }

    // 404 - 未找到路由
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: '未找到请求的接口' }));
  });

  server.listen(port, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 HTTP API 服务已启动');
    console.log('='.repeat(60));
    console.log(`   监听端口: ${port}`);
    console.log(`   接口地址: http://localhost:${port}/api/contracts/:id/analyze`);
    console.log('='.repeat(60));
    console.log('\n按 Ctrl+C 停止服务\n');
  });

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n\n👋 正在关闭 HTTP 服务...');
    server.close(() => {
      console.log('✅ 服务已关闭');
      process.exit(0);
    });
  });
}

// ==================== 程序入口 ====================

(async () => {
  const options = parseArgs();

  try {
    switch (options.command) {
      case 'help':
        showHelp();
        process.exit(0);
        break;

      case 'test':
        await testConnections();
        break;

      case 'stats':
        await showStats();
        break;

      case 'server':
        await startHttpServer(options);
        break;

      case 'analyze':
      default:
        await initialize();
        await main(options);
        break;
    }
  } catch (error) {
    console.error(`\n❌ 程序错误: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
})();

// 导出供其他模块使用
module.exports = {
  SignatureLoader,
  Web3Manager,
  DBManager,
  ContractAnalyzer,
  FunctionFuzzer
};
