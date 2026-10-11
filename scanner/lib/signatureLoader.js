const fs = require('fs');
const readline = require('readline');

/**
 * 函数签名加载器
 * 从 export.txt 文件加载函数签名，提供查询功能
 */
class SignatureLoader {
  constructor() {
    this.signatureMap = new Map();
    this.loaded = false;
  }

  /**
   * 从文件加载函数签名
   * @param {string} filePath - 签名文件路径（如 './export.txt'）
   * @returns {Promise<void>}
   */
  async load(filePath) {
    console.log(`📖 正在加载函数签名数据库: ${filePath}`);

    try {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let count = 0;
      for await (const line of rl) {
        // 找到第一个逗号的索引
        const commaIndex = line.indexOf(',');

        if (commaIndex !== -1) {
          // 使用第一个逗号来分割字符串
          const signature = line.slice(0, commaIndex); // 提取函数选择器
          const funcName = line.slice(commaIndex + 1);  // 提取函数签名

          // 如果该选择器在 map 中不存在，则初始化为一个空数组
          if (!this.signatureMap.has(signature)) {
            this.signatureMap.set(signature, []);
          }
          // 将函数签名添加到对应的数组中
          this.signatureMap.get(signature).push(funcName);
          count++;
        }
      }

      this.loaded = true;
      console.log(`✅ 函数签名加载完成，共加载 ${count} 条记录`);
      console.log(`   独立选择器数量: ${this.signatureMap.size}`);

    } catch (error) {
      console.error(`❌ 加载函数签名失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 根据选择器查找函数签名
   * @param {string} selector - 函数选择器（如 '0xa9059cbb'）
   * @returns {Array<string>} 函数签名数组
   */
  find(selector) {
    // 确保选择器以 0x 开头
    const normalizedSelector = selector.startsWith('0x') ? selector : `0x${selector}`;
    return this.signatureMap.get(normalizedSelector) || [];
  }

  /**
   * 获取统计信息
   * @returns {Object}
   */
  getStats() {
    let totalSignatures = 0;
    for (const signatures of this.signatureMap.values()) {
      totalSignatures += signatures.length;
    }

    return {
      selectors: this.signatureMap.size,
      totalSignatures,
      loaded: this.loaded
    };
  }

  /**
   * 检查是否已加载
   * @returns {boolean}
   */
  isLoaded() {
    return this.loaded;
  }
}

module.exports = SignatureLoader;
