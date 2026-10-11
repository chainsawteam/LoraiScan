const Web3 = require('web3');

/**
 * Web3 多链管理器
 * 管理多条区块链的 Web3 实例
 */
class Web3Manager {
  constructor() {
    this.instances = new Map();
    this.chainRPCs = {
      BSC: process.env.BSC_RPC || 'https://bsc-dataseed1.binance.org',
      ETH: process.env.ETH_RPC || 'https://eth.llamarpc.com',
      ARB: process.env.ARB_RPC || 'https://arbitrum.llamarpc.com'
    };

    this.chainIds = {
      BSC: 56,
      ETH: 1,
      ARB: 42161
    };

    this.initAllChains();
  }

  /**
   * 初始化所有链的 Web3 实例
   */
  initAllChains() {
    console.log('🔗 初始化 Web3 多链连接...');

    for (const [name, rpc] of Object.entries(this.chainRPCs)) {
      try {
        const web3 = new Web3(new Web3.providers.HttpProvider(rpc, {
          timeout: 30000,  // 30秒超时
          keepAlive: true
        }));
        this.instances.set(name, web3);
        console.log(`   ✅ ${name}: ${rpc}`);
      } catch (error) {
        console.error(`   ❌ ${name} 初始化失败: ${error.message}`);
      }
    }

    console.log(`✅ 共初始化 ${this.instances.size} 条链的 Web3 连接`);
  }

  /**
   * 获取指定链的 Web3 实例
   * @param {string} chainName - 链名称（如 'BSC', 'ETH'）
   * @returns {Web3}
   */
  getWeb3(chainName) {
    const web3 = this.instances.get(chainName);
    if (!web3) {
      throw new Error(`不支持的链: ${chainName}`);
    }
    return web3;
  }

  /**
   * 获取指定链的链ID
   * @param {string} chainName - 链名称
   * @returns {number}
   */
  getChainId(chainName) {
    return this.chainIds[chainName];
  }

  /**
   * 检查是否支持指定链
   * @param {string} chainName - 链名称
   * @returns {boolean}
   */
  isSupported(chainName) {
    return this.instances.has(chainName);
  }

  /**
   * 获取所有已支持的链名称
   * @returns {Array<string>}
   */
  getSupportedChains() {
    return Array.from(this.instances.keys());
  }

  /**
   * 测试指定链的连接
   * @param {string} chainName - 链名称
   * @returns {Promise<boolean>}
   */
  async testConnection(chainName) {
    try {
      const web3 = this.getWeb3(chainName);
      const blockNumber = await web3.eth.getBlockNumber();
      console.log(`   ✅ ${chainName} 连接正常，当前区块: ${blockNumber}`);
      return true;
    } catch (error) {
      console.error(`   ❌ ${chainName} 连接失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 测试所有链的连接
   * @returns {Promise<Object>}
   */
  async testAllConnections() {
    const results = {};
    console.log('🔍 测试所有链的连接...');

    for (const chainName of this.getSupportedChains()) {
      results[chainName] = await this.testConnection(chainName);
    }

    return results;
  }

  /**
   * 获取合约字节码
   * @param {string} chainName - 链名称
   * @param {string} contractAddress - 合约地址
   * @returns {Promise<string>} 合约字节码
   */
  async getContractCode(chainName, contractAddress) {
    const web3 = this.getWeb3(chainName);
    const code = await web3.eth.getCode(contractAddress);
    return code;
  }

  /**
   * 检查地址是否为合约
   * @param {string} chainName - 链名称
   * @param {string} address - 地址
   * @returns {Promise<boolean>}
   */
  async isContract(chainName, address) {
    const code = await this.getContractCode(chainName, address);
    return code !== '0x' && code !== '0x0';
  }
}

module.exports = Web3Manager;
