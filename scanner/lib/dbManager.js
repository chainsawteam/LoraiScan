/**
 * 数据库管理器
 * 管理 lora 数据库的连接和操作
 */
class DBManager {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 根据ID获取合约信息
   * @param {number} id - 合约ID
   * @returns {Promise<Object|null>}
   */
  async getContractById(id) {
    const sql = `
      SELECT
        id,
        contract_address,
        chain_name,
        tx_hash,
        deployer_address,
        status
      FROM new_contracts
      WHERE id = ?
    `;

    try {
      const [rows] = await this.pool.execute(sql, [id]);
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      console.error(`❌ 获取合约信息失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取待分析的合约列表
   * @param {string|null} chain - 链名称筛选（可选）
   * @param {number} limit - 限制数量
   * @returns {Promise<Array>}
   */
  async getPendingContracts(chain = null, limit = 100) {
    let sql = `
      SELECT
        id,
        contract_address,
        chain_name,
        tx_hash,
        deployer_address,
        status
      FROM new_contracts
      WHERE status = 'pending'
    `;
    const params = [];

    // 添加链筛选
    if (chain) {
      sql += ` AND chain_name = ?`;
      params.push(chain);
    }

    // 添加排序和限制（LIMIT 直接拼接到 SQL 中）
    sql += ` ORDER BY first_seen_at ASC LIMIT ${parseInt(limit)}`;

    try {
      const [rows] = await this.pool.execute(sql, params);
      return rows;
    } catch (error) {
      console.error(`❌ 获取待分析合约失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 保存合约分析结果
   * @param {number} contractId - 合约ID
   * @param {Array} functions - 函数列表
   * @param {Object} testResults - 测试结果
   * @returns {Promise<void>}
   */
  async saveAnalysisResult(contractId, functions, testResults) {
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();

      // 1. 更新合约表
      const updateContractSQL = `
        UPDATE new_contracts
        SET
          function_count = ?,
          success_call_count = ?,
          fail_call_count = ?,
          analysis_result = ?,
          updated_at = NOW()
        WHERE id = ?
      `;

      // 将函数信息（name, args）合并到测试结果中
      const resultsWithDetails = (testResults.results || []).map(result => {
        const func = functions.find(f => f.selector === result.selector);
        return {
          selector: result.selector,
          name: func?.name || null,
          args: func?.args || '',
          success: result.success,
          result: result.result,
          error: result.error
        };
      });

      const analysisResult = JSON.stringify(resultsWithDetails);

      await connection.execute(updateContractSQL, [
        functions.length,
        testResults.success || 0,
        testResults.failed || 0,
        analysisResult,
        contractId
      ]);

      // 2. 插入函数记录
      if (functions.length > 0) {
        // 先删除该合约的旧函数记录
        await connection.execute(
          'DELETE FROM contract_functions WHERE contract_id = ?',
          [contractId]
        );

        // 批量插入函数记录
        const insertFuncSQL = `
          INSERT INTO contract_functions (
            contract_id,
            contract_address,
            chain_name,
            selector,
            name,
            signature,
            type,
            param_count,
            inputs,
            risk_flag,
            created_at
          ) VALUES ?
        `;

        const values = functions.map(f => [
          contractId,
          f.contractAddress,
          f.chainName,
          f.selector,
          f.name || null,
          f.signature || null,
          f.state || 'nonpayable',
          f.paramCount || 0,
          JSON.stringify(this.parseInputs(f.args)),
          this.assessRisk(f),
          new Date()
        ]);

        await connection.query(insertFuncSQL, [values]);
      }

      await connection.commit();
      console.log(`   💾 分析结果已保存到数据库`);

    } catch (error) {
      await connection.rollback();
      console.error(`❌ 保存分析结果失败: ${error.message}`);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 将参数字符串转换为输入参数数组
   * @param {string} args - 参数字符串（如 'address,uint256'）
   * @returns {Array}
   */
  parseInputs(args) {
    if (!args) return [];

    const params = args.split(',').filter(Boolean);
    return params.map((type, index) => ({
      name: `param${index}`,
      type: type.trim()
    }));
  }

  /**
   * 评估函数风险等级
   * @param {Object} func - 函数对象
   * @returns {number} 0=正常, 1=敏感, 2=危险
   */
  assessRisk(func) {
    const name = (func.name || '').toLowerCase();
    const signature = (func.signature || '').toLowerCase();

    // 危险函数（risk_flag = 2）
    const dangerousPatterns = [
      'selfdestruct', 'destroy', 'renounce', 'withdraw',
      'mint', 'burn', 'transferownership', 'claimownership'
    ];

    // 敏感函数（risk_flag = 1）
    const sensitivePatterns = [
      'transferfrom', 'approve', 'set', 'change', 'update',
      'multicall', 'execute', 'batch'
    ];

    for (const pattern of dangerousPatterns) {
      if (name.includes(pattern) || signature.includes(pattern)) {
        return 2;
      }
    }

    for (const pattern of sensitivePatterns) {
      if (name.includes(pattern) || signature.includes(pattern)) {
        return 1;
      }
    }

    return 0; // 正常函数
  }

  /**
   * 标记合约为已分析
   * @param {number} id - 合约ID
   * @returns {Promise<void>}
   */
  async markContractAnalyzed(id) {
    const sql = `
      UPDATE new_contracts
      SET status = 'analyzed', updated_at = NOW()
      WHERE id = ?
    `;

    try {
      await this.pool.execute(sql, [id]);
      console.log(`   ✅ 合约 #${id} 已标记为已分析`);
    } catch (error) {
      console.error(`❌ 更新合约状态失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 标记合约为无效（没有字节码或函数数为0）
   * @param {number} id - 合约ID
   * @param {string} reason - 原因
   * @returns {Promise<void>}
   */
  async markContractInvalid(id, reason) {
    const sql = `
      UPDATE new_contracts
      SET
        status = 'invalid',
        remark = ?,
        updated_at = NOW()
      WHERE id = ?
    `;

    try {
      await this.pool.execute(sql, [reason, id]);
      console.log(`   ⚠️ 合约 #${id} 已标记为无效: ${reason}`);
    } catch (error) {
      console.error(`❌ 更新合约状态失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 标记合约为代理合约
   * @param {number} id - 合约ID
   * @param {string} proxyType - 代理类型
   * @param {string} reason - 原因
   * @returns {Promise<void>}
   */
  async markContractProxy(id, proxyType, reason) {
    const sql = `
      UPDATE new_contracts
      SET
        status = 'analyzed',
        remark = CONCAT(IFNULL(remark, ''), ' ', ?),
        updated_at = NOW()
      WHERE id = ?
    `;

    try {
      const remark = `[代理合约] ${proxyType}: ${reason}`;
      await this.pool.execute(sql, [remark, id]);
      console.log(`   🛡️ 合约 #${id} 已识别为代理合约 (${proxyType})`);
    } catch (error) {
      console.error(`❌ 更新合约状态失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取合约统计信息
   * @returns {Promise<Object>}
   */
  async getStats() {
    const sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'analyzed' THEN 1 ELSE 0 END) as analyzed,
        SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid
      FROM new_contracts
    `;

    try {
      const [rows] = await this.pool.execute(sql);
      return rows[0];
    } catch (error) {
      console.error(`❌ 获取统计信息失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检查数据库连接
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      const [rows] = await this.pool.execute('SELECT 1 as result');
      return rows[0].result === 1;
    } catch (error) {
      console.error(`❌ 数据库连接测试失败: ${error.message}`);
      return false;
    }
  }
}

module.exports = DBManager;
