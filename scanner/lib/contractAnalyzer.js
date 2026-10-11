const evmole = require('evmole');

/**
 * 合约分析器
 * 使用 evmole 分析合约字节码，提取函数信息
 */
class ContractAnalyzer {
  constructor(web3Manager, signatureLoader) {
    this.web3Manager = web3Manager;
    this.signatureLoader = signatureLoader;
  }

  /**
   * 获取合约字节码
   * @param {Object} contract - 合约对象
   * @returns {Promise<string>}
   */
  async getBytecode(contract) {
    const { contract_address, chain_name } = contract;

    console.log(`   📍 合约地址: ${contract_address}`);
    console.log(`   🔗 链名称: ${chain_name}`);

    // 始终从链上获取字节码（不使用数据库中的，因为可能被截断）
    console.log(`   🔽 从链上获取字节码...`);
    const bytecode = await this.web3Manager.getContractCode(chain_name, contract_address);

    if (!bytecode || bytecode === '0x' || bytecode === '0x0') {
      throw new Error('不是有效的合约地址或合约不存在');
    }

    console.log(`   ✅ 字节码获取成功 (${bytecode.length} 字符)`);
    console.log(`   🔍 字节码预览: ${bytecode.substring(0, 50)}...`);
    console.log(`   🔍 字节码末尾: ...${bytecode.substring(bytecode.length - 50)}`);

    // 如果字节码太短，发出警告
    if (bytecode.length < 1000) {
      console.warn(`   ⚠️ 字节码长度异常短 (${bytecode.length} 字符)，可能不是完整合约`);
    }

    return bytecode;
  }

  /**
   * 分析合约函数
   * @param {string} bytecode - 合约字节码
   * @param {string} contractAddress - 合约地址
   * @param {string} chainName - 链名称
   * @returns {Promise<Array>}
   */
  async analyzeFunctions(bytecode, contractAddress, chainName) {
    console.log(`   🔍 开始分析函数...`);
    console.log(`   📦 字节码长度: ${bytecode.length} 字符`);

    try {
      // 使用新的 contractInfo 方法（替代废弃的 functionSelectors）
      const info = evmole.contractInfo(bytecode, {
          selectors: true,
          arguments: true,
          stateMutability: true
      });

      if (!info || !info.functions || info.functions.length === 0) {
        console.warn(`   ⚠️ 未找到任何函数选择器，字节码可能无效`);
        return [];
      }

      console.log(`   📋 发现 ${info.functions.length} 个函数选择器`);

      const functions = [];

      // 遍历每个函数，获取详细信息
      info.functions.forEach(func => {
        const selector = `0x${func.selector}`;
        const signatures = this.signatureLoader.find(selector);
        const stateMutability = func.stateMutability || '';


        // 过滤掉 view 和 pure 函数
        if (stateMutability !== 'view' && stateMutability !== 'pure') {
            functions.push({
                selector,
                name: signatures[0] || "unknown_" + selector,
                args: func.arguments || '',
                state: func.stateMutability,
                paramCount: func.arguments ? func.arguments.split(',').filter(Boolean).length : 0,
                contractAddress,
                chainName
            });
        }
        
      });

      console.log(`   ✅ 分析完成，找到 ${functions.length} 个函数`);
      return functions;

    } catch (error) {
      console.error(`   ❌ 函数分析失败: ${error.message}`);
      console.error(`   📋 错误堆栈: ${error.stack}`);
      throw error;
    }
  }

  /**
   * 分析单个合约（完整流程）
   * @param {Object} contract - 合约对象
   * @returns {Promise<Object>}
   */
  async analyze(contract) {
    try {
      // 1. 获取字节码
      const bytecode = await this.getBytecode(contract);

      // 2. 分析函数
      const functions = await this.analyzeFunctions(
        bytecode,
        contract.contract_address,
        contract.chain_name
      );

      // 3. 检测代理合约
      const proxyInfo = this.detectProxy(bytecode, contract);

      return {
        success: true,
        functions,
        bytecode,
        proxyInfo
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        functions: [],
        bytecode: null,
        proxyInfo: { isProxy: false, proxyType: null, reason: error.message }
      };
    }
  }

  /**
   * 批量分析合约
   * @param {Array} contracts - 合约数组
   * @returns {Promise<Array>}
   */
  async analyzeBatch(contracts) {
    const results = [];

    for (const contract of contracts) {
      console.log(`\n🔍 分析合约 #${contract.id}: ${contract.contract_address} (${contract.chain_name})`);

      const result = await this.analyze(contract);
      results.push({
        contractId: contract.id,
        ...result
      });
    }

    return results;
  }

  /**
   * 验证字节码是否有效
   * @param {string} bytecode - 字节码
   * @returns {boolean}
   */
  isValidBytecode(bytecode) {
    return bytecode &&
           bytecode.length > 10 &&
           bytecode.startsWith('0x') &&
           bytecode !== '0x' &&
           bytecode !== '0x0';
  }

  /**
   * 提取函数选择器
   * @param {string} bytecode - 字节码
   * @returns {Array<string>}
   */
  extractSelectors(bytecode) {
    try {
      return evmole.functionSelectors(bytecode, 0).map(item => `0x${item}`);
    } catch (error) {
      console.error(`提取选择器失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 获取函数参数类型
   * @param {string} bytecode - 字节码
   * @param {string} selector - 选择器
   * @returns {string}
   */
  getFunctionArgs(bytecode, selector) {
    try {
      return evmole.functionArguments(bytecode, selector, 0);
    } catch (error) {
      return '';
    }
  }

  /**
   * 获取函数状态可变性
   * @param {string} bytecode - 字节码
   * @param {string} selector - 选择器
   * @returns {string}
   */
  getFunctionStateMutability(bytecode, selector) {
    try {
      return evmole.functionStateMutability(bytecode, selector, 0);
    } catch (error) {
      return 'nonpayable';
    }
  }

  /**
   * 检测合约是否为代理合约
   * @param {string} bytecode - 合约字节码
   * @param {Object} contract - 合约对象
   * @returns {Object} {isProxy: boolean, proxyType: string, reason: string}
   */
  detectProxy(bytecode, contract) {
    if (!bytecode || bytecode === '0x') {
      return { isProxy: false, proxyType: null, reason: '无效字节码' };
    }

    const code = bytecode.toLowerCase();
    const result = {
      isProxy: false,
      proxyType: null,
      reason: '非代理合约'
    };

    // 1. 检测 DELEGATECALL (0xf4)
    const hasDelegatecall = code.includes('f4');
    if (!hasDelegatecall) {
      return result;
    }

    // 2. Hardcoded implementation delegatecall proxy (e.g. Ownbit)
    const hardcodedImplMatch = code.match(/73[0-9a-f]{40}5af4|73[0-9a-f]{40}f4/);
    if (hardcodedImplMatch) {
      return {
        isProxy: true,
        proxyType: 'Hardcoded Delegatecall Proxy',
        reason: '检测到 PUSH20 + DELEGATECALL 硬编码实现地址'
      };
    }

    // 3. EIP-1967 标准代理
    const eip1967ImplSlot = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    if (code.includes(eip1967ImplSlot)) {
      return {
        isProxy: true,
        proxyType: 'EIP-1967',
        reason: '检测到 EIP-1967 标准代理'
      };
    }

    // 3. EIP-1167 最小代理
    const eip1167Prefix = '0x363d3d373d3d3d363d73';
    const eip1167Suffix = '5af43d82803e903d91602b57fd5bf3';
    if (code.startsWith(eip1167Prefix) && code.endsWith(eip1167Suffix)) {
      return {
        isProxy: true,
        proxyType: 'EIP-1167',
        reason: '检测到 EIP-1167 最小代理'
      };
    }

    // 4. 通用代理模式
    const hasCalldataCopy = code.includes('37');  // calldatacopy
    const hasReturnDataCopy = code.includes('3e'); // returndatacopy
    if (hasDelegatecall && hasCalldataCopy && hasReturnDataCopy) {
      return {
        isProxy: true,
        proxyType: 'Generic Proxy',
        reason: '检测到通用代理模式'
      };
    }

    return result;
  }

  /**
   * 获取代理合约的实现合约地址
   * 支持多种代理类型：EIP-1967, EIP-1167, EIP-1822, Beacon
   * @param {string} bytecode - 代理合约字节码
   * @param {string} contractAddress - 代理合约地址
   * @param {string} chainName - 链名称
   * @returns {Promise<string|null>} 实现合约地址或null
   */
  async getImplementationAddress(bytecode, contractAddress, chainName) {
    try {
      const web3 = this.web3Manager.getWeb3(chainName);
      const code = bytecode.toLowerCase();

      // 0. Hardcoded implementation (Ownbit / static delegatecall proxy)
      const hardcodedMatches = [];
      const regex = /73([0-9a-f]{40})5af4|73([0-9a-f]{40})f4/g;

      let match;
      while ((match = regex.exec(code)) !== null) {
        const addr = match[1] || match[2];
        if (addr) {
          hardcodedMatches.push('0x' + addr);
        }
      }

      // 去重
      const unique = [...new Set(hardcodedMatches)];

      if (unique.length === 1) {
        console.log(`   🔍 Hardcoded Proxy: 从字节码解析实现合约地址: ${unique[0]}`);
        return unique[0];
      }

      if (unique.length > 1) {
        console.warn(`   ⚠️ 检测到多个硬编码 delegatecall 地址，无法确定唯一实现`, unique);
      }

      // 1. EIP-1167 最小代理（克隆合约）- 支持多种变体
      // 常见格式：前缀 + 20字节地址 + 后缀
      const eip1167Suffix = '5af43d82803e903d91602b57fd5bf3';

      // 尝试多种可能的前缀
      const eip1167Prefixes = [
        '363d3d373d3d3d363d73',  // 标准前缀
        '3d3d3d373d3d3d363d73',   // 短前缀（少一个3d）
        '363d3d373d3d3d363d73be'  // 带 be 后缀
      ];

      // 查找后缀位置
      const suffixIndex = code.indexOf(eip1167Suffix);
      if (suffixIndex !== -1) {
        console.log(`   🔍 检测到 EIP-1167 后缀，尝试多种前缀...`);

        // 尝试每种前缀
        for (const prefix of eip1167Prefixes) {
          const prefixIndex = code.indexOf(prefix);
          if (prefixIndex !== -1 && prefixIndex < suffixIndex) {
            // 计算地址位置：前缀结束后开始，后缀开始前结束
            const addressStart = prefixIndex + prefix.length;
            const addressEnd = suffixIndex;

            // 验证地址长度（应该是40个字符，20字节）
            const addressLength = addressEnd - addressStart;

            if (addressLength === 40) {
              const address = '0x' + code.substring(addressStart, addressEnd);

              // 验证地址格式（只包含十六进制字符）
              if (/^0x[0-9a-f]{40}$/.test(address)) {
                console.log(`   ✅ EIP-1167: 使用前缀 "${prefix}" 提取到实现合约地址`);
                console.log(`      地址: ${address}`);
                console.log(`      前缀位置: ${prefixIndex}, 地址位置: ${addressStart}-${addressEnd}, 后缀位置: ${suffixIndex}`);
                return address;
              }
            }
          }
        }

        console.log(`   ⚠️ EIP-1167: 找到后缀但无法提取有效地址`);
      }

      // 2. EIP-1967 标准代理（implementation slot）
      const eip1967ImplSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      if (code.includes(eip1967ImplSlot.substring(2))) { // 去掉0x比较
        const storage = await web3.eth.getStorageAt(contractAddress, eip1967ImplSlot);
        const address = '0x' + storage.slice(-40);

        if (address !== '0x0000000000000000000000000000000000000000' && address !== '0x') {
          console.log(`   🔍 EIP-1967: 从存储槽读取实现合约地址: ${address}`);
          return address;
        }
      }

      // 3. EIP-1822 UUPS代理（immutable slot）
      // 在构造时设置，通常也是 EIP-1967 的 beacon slot
      const beaconSlot = '0x0000000000000000000000000000000000000000000000000000000000000000001';
      if (code.includes('a5190c66')) { // keccak256("eip1967.proxy.implementation") == 0xa5190c66
        try {
          const storage = await web3.eth.getStorageAt(contractAddress, beaconSlot);
          const address = '0x' + storage.slice(-40);

          if (address !== '0x0000000000000000000000000000000000000000' && address !== '0x') {
            console.log(`   🔍 EIP-1822/UUPS: 从存储槽读取实现合约地址: ${address}`);
            return address;
          }
        } catch (e) {
          // 忽略错误，继续尝试其他方法
        }
      }

      // 4. Gnosis Safe 代理（从存储槽读取）
      // 使用 EIP-1967 beacon slot
      try {
        const storage = await web3.eth.getStorageAt(contractAddress, beaconSlot);
        const address = '0x' + storage.slice(-40);

        if (address !== '0x0000000000000000000000000000000000000000' && address !== '0x') {
          console.log(`   🔍 Gnosis Safe: 从beacon槽读取实现合约地址: ${address}`);
          return address;
        }
      } catch (e) {
        // 忽略错误
      }

      console.log(`   ⚠️ 无法获取实现合约地址`);
      return null;

    } catch (error) {
      console.error(`获取实现合约地址失败: ${error.message}`);
      return null;
    }
  }
}

module.exports = ContractAnalyzer;
