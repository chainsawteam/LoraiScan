/**
 * 函数 Fuzz 测试器
 * 对合约函数进行模糊测试调用
 */
class FunctionFuzzer {
  constructor(web3Manager, signatureLoader) {
    this.web3Manager = web3Manager;
    this.signatureLoader = signatureLoader;
  }

  /**
   * 根据参数类型生成随机测试值
   * @param {string} paramTypes - 参数类型字符串（如 'address,uint256'）
   * @returns {Array}
   */
  generateTestParams(paramTypes) {
    if (!paramTypes) return [];

    const params = paramTypes.split(',').filter(Boolean);
    return params.map(type => {
      const possibleValues = this.getPossibleValuesForType(type.trim());
      // 随机选择一个值
      const randomIndex = Math.floor(Math.random() * possibleValues.length);
      return possibleValues[randomIndex];
    });
  }

  /**
   * 为单个类型生成可能的测试值列表
   * @param {string} type - 参数类型
   * @returns {Array} - 该类型的可能测试值
   */
  getPossibleValuesForType(type) {
    // 先判断数组类型
    if (type.includes('[') && type.includes(']')) {
      const baseType = type.substring(0, type.indexOf('['));
      const baseValues = this.getPossibleValuesForType(baseType);
      // 返回每个基础值作为单元素数组
      return baseValues.map(v => [v]);
    }

    // uint 类型 - 尝试边界值和典型值
    if (type.includes('uint')) {
      return ['0', '1', '100', '1000000000000000000'];
    }

    // int 类型
    if (type.includes('int')) {
      return ['0', '1', '-1', '100'];
    }

    // bool 类型 - 尝试 true 和 false
    if (type.includes('bool')) {
      return [true, false];
    }

    // address 类型 - 尝试不同地址
    if (type.includes('address')) {
      return [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000000',
        '0xffffffffffffffffffffffffffffffffffffffff'
      ];
    }

    // bytes 类型
    if (type.includes('bytes')) {
      return ['0x', '0x1234', '0xffffffff'];
    }

    // string 类型
    if (type.includes('string')) {
      return ['', 'test', 'a'];
    }

    // 默认值
    return ['1'];
  }

  /**
   * 为单个类型生成随机测试值（复用 getPossibleValuesForType）
   * @param {string} type - 参数类型
   * @returns {*}
   */
  generateValueForType(type) {
    const possibleValues = this.getPossibleValuesForType(type);
    // 返回第一个值作为默认值
    return possibleValues[0];
  }

  /**
   * 对单个函数进行 Fuzz 测试
   * @param {Object} contract - 合约对象
   * @param {Object} func - 函数对象
   * @returns {Promise<Object>}
   */
  async fuzzFunction(contract, func) {
    const { contract_address, chain_name } = contract;
    const { selector, args } = func;

    try {
      const web3 = this.web3Manager.getWeb3(chain_name);

      // 生成测试参数（随机选择）
      const testParams = this.generateTestParams(args);

      // 构造调用数据
      const callData = selector + this.encodeParams(args, testParams);

      // 模拟调用（使用测试地址作为 from）
      const result = await web3.eth.call({
        from: '0x0000000000000000000000000000000000000001', // 测试地址
        to: contract_address,
        data: callData
      });

      return {
        selector,
        success: true,
        result: result.substring(0, 100), // 只保存前100个字符
        error: null
      };

    } catch (error) {
      // 大多数情况下会失败（revert），这是正常的
      let errorMessage = error.message || 'execution reverted';

      console.log(`   🔍 错误信息原始值: ${errorMessage}`);

      // 尝试解析错误信息中的函数选择器
      // 错误格式示例: execution reverted: 0x99c6cd710000000000000000000000000000000000000000000000000000000000000001
      const selectorMatch = errorMessage.match(/0x([0-9a-fA-F]{8})/);
      console.log(`   🔍 正则匹配结果: ${selectorMatch ? selectorMatch[0] : '未匹配到选择器'}`);

      if (selectorMatch) {
        const errorSelector = '0x' + selectorMatch[1];
        console.log(`   🔍 提取的选择器: ${errorSelector}`);

        const signatures = this.signatureLoader.find(errorSelector);
        console.log(`   🔍 查询到的签名: ${signatures ? signatures.join(', ') : '无'}`);

        if (signatures && signatures.length > 0) {
          // 找到签名，替换显示
          errorMessage = errorMessage.replace(
            selectorMatch[0],
            `${errorSelector} (${signatures[0]})`
          );
          console.log(`   ✅ 替换后的错误信息: ${errorMessage}`);
        } else {
          console.log(`   ⚠️ 未找到签名，保持原错误信息`);
        }
      }

      return {
        selector,
        success: false,
        result: null,
        error: errorMessage
      };
    }
  }

  /**
   * 编码参数
   * @param {string} types - 参数类型字符串（如 'address,uint256,bool'）
   * @param {Array} values - 参数值数组
   * @returns {string} - 编码后的参数（不含 0x 前缀）
   */
  encodeParams(types, values) {
    try {
      // 如果没有参数，返回空字符串
      if (!types || types === '') {
        return '';
      }

      // 解析类型字符串为数组（如 'address,uint256' -> ['address', 'uint256']）
      const typeArray = types.split(',').filter(t => t.trim() !== '');

      // 创建一个临时的 Web3 实例用于编码（不需要连接区块链）
      const Web3 = require('web3');
      const web3 = new Web3();

      // 使用 Web3 的 ABI 编码功能
      const encoded = web3.eth.abi.encodeParameters(typeArray, values);

      // 去掉 '0x' 前缀并返回
      return encoded.substring(2);

    } catch (error) {
      console.error('参数编码失败:', error.message);
      console.error('类型:', types);
      console.error('值:', values);
      return '';
    }
  }

  /**
   * 对所有函数进行批量 Fuzz 测试
   * @param {Object} contract - 合约对象
   * @param {Array} functions - 函数数组
   * @returns {Promise<Object>}
   */
  async fuzzAll(contract, functions) {
    console.log(`   🧪 开始 Fuzz 测试 ${functions.length} 个函数...`);

    let success = 0;
    let failed = 0;
    const results = [];

    // 测试所有函数，不限制数量
    for (let i = 0; i < functions.length; i++) {
      const func = functions[i];

      try {
        const result = await this.fuzzFunction(contract, func);
        results.push(result);

        if (result.success) {
          success++;
          console.log(`      ✅ [${i + 1}/${functions.length}] ${func.selector.substring(0, 10)}... 成功`);
        } else {
          failed++;
          console.log(`      ❌ [${i + 1}/${functions.length}] ${func.selector.substring(0, 10)}... 失败`);
        }

      } catch (error) {
        failed++;
        results.push({
          selector: func.selector,
          success: false,
          result: null,
          error: error.message
        });
      }
    }

    console.log(`   📊 测试完成: ${success} 成功, ${failed} 失败`);

    return {
      success,
      failed,
      total: functions.length,
      results: results // 保存所有结果
    };
  }

  /**
   * 延迟函数
   * @param {number} ms - 毫秒
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 快速测试（只测试前N个函数）
   * @param {Object} contract - 合约对象
   * @param {Array} functions - 函数数组
   * @param {number} limit - 限制数量
   * @returns {Promise<Object>}
   */
  async quickFuzz(contract, functions, limit = 10) {
    const subset = functions.slice(0, limit);
    return await this.fuzzAll(contract, subset);
  }

  /**
   * 智能测试（根据函数风险等级选择测试函数）
   * @param {Object} contract - 合约对象
   * @param {Array} functions - 函数数组
   * @returns {Promise<Object>}
   */
  async smartFuzz(contract, functions) {
    // 优先测试危险和敏感函数
    const priorityFuncs = functions.filter(f => {
      const name = (f.name || '').toLowerCase();
      return name.includes('withdraw') ||
             name.includes('mint') ||
             name.includes('burn') ||
             name.includes('transfer') ||
             name.includes('approve');
    });

    console.log(`   🎯 智能测试: 优先测试 ${priorityFuncs.length} 个敏感函数`);

    return await this.fuzzAll(contract, priorityFuncs);
  }
}

module.exports = FunctionFuzzer;
