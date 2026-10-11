class LoraRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async testConnection() {
    const connection = await this.pool.getConnection();
    connection.release();
  }

  async listNotifications(options) {
    const validSortFields = ['id', 'plugin_name', 'chain', 'alert_type', 'created_at'];
    const validSortDirections = ['asc', 'desc'];
    const orderField = validSortFields.includes(options.sortField) ? options.sortField : 'id';
    const orderDirection = validSortDirections.includes(String(options.sortDirection || '').toLowerCase())
      ? String(options.sortDirection).toUpperCase()
      : 'DESC';
    const conditions = [];
    const params = [];

    if (options.search) {
      const searchPattern = `%${String(options.search).toLowerCase()}%`;
      conditions.push('(LOWER(tx_hash) LIKE ? OR LOWER(contract_address) LIKE ? OR LOWER(from_address) LIKE ? OR LOWER(to_address) LIKE ? OR LOWER(token_name) LIKE ? OR LOWER(message) LIKE ?)');
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    if (options.plugin_name) {
      conditions.push('plugin_name = ?');
      params.push(options.plugin_name);
    }
    if (options.chain) {
      conditions.push('chain = ?');
      params.push(options.chain);
    }
    if (options.alert_type) {
      conditions.push('alert_type = ?');
      params.push(options.alert_type);
    }
    if (options.is_viewed !== '' && options.is_viewed !== undefined) {
      conditions.push('is_viewed = ?');
      params.push(parseInt(options.is_viewed, 10));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRows] = await this.pool.execute(`SELECT COUNT(*) AS total FROM notifications ${whereClause}`, params);
    const [rows] = await this.pool.query(
      `SELECT * FROM notifications ${whereClause} ORDER BY ${orderField} ${orderDirection} LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset]
    );
    return {
      total: countRows[0].total,
      rows
    };
  }

  async getNotificationStats() {
    const [stats] = await this.pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_viewed = 0 THEN 1 ELSE 0 END) AS unviewed,
        SUM(CASE WHEN is_viewed = 1 THEN 1 ELSE 0 END) AS viewed
      FROM notifications
    `);
    const [pluginStats] = await this.pool.execute(`
      SELECT plugin_name, COUNT(*) AS count, SUM(CASE WHEN is_viewed = 0 THEN 1 ELSE 0 END) AS unviewed
      FROM notifications
      GROUP BY plugin_name
    `);
    return { ...stats[0], byPlugin: pluginStats };
  }

  async markNotificationsViewedByFilter(filters) {
    const conditions = ['is_viewed = 0'];
    const params = [];

    if (filters.search) {
      const searchPattern = `%${String(filters.search).toLowerCase()}%`;
      conditions.push('(LOWER(tx_hash) LIKE ? OR LOWER(contract_address) LIKE ? OR LOWER(from_address) LIKE ? OR LOWER(to_address) LIKE ? OR LOWER(token_name) LIKE ? OR LOWER(message) LIKE ?)');
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    if (filters.plugin_name) {
      conditions.push('plugin_name = ?');
      params.push(filters.plugin_name);
    }
    if (filters.chain) {
      conditions.push('chain = ?');
      params.push(filters.chain);
    }
    if (filters.alert_type) {
      conditions.push('alert_type = ?');
      params.push(filters.alert_type);
    }

    const [result] = await this.pool.execute(
      `UPDATE notifications SET is_viewed = 1, viewed_at = ? WHERE ${conditions.join(' AND ')}`,
      [new Date(), ...params]
    );
    return result.affectedRows;
  }

  async getNotificationById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM notifications WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async updateNotificationViewed(id, isViewed) {
    const [result] = await this.pool.execute(
      'UPDATE notifications SET is_viewed = ?, viewed_at = ? WHERE id = ?',
      [isViewed, isViewed === 1 ? new Date() : null, id]
    );
    return result.affectedRows;
  }

  async updateNotificationRemark(id, remark) {
    const [result] = await this.pool.execute(
      'UPDATE notifications SET remark = ?, remark_updated_at = ? WHERE id = ?',
      [remark || null, new Date(), id]
    );
    return result.affectedRows;
  }

  async batchUpdateNotificationViewed(ids, isViewed) {
    const placeholders = ids.map(() => '?').join(',');
    const [result] = await this.pool.execute(
      `UPDATE notifications SET is_viewed = ?, viewed_at = ? WHERE id IN (${placeholders})`,
      [isViewed, isViewed === 1 ? new Date() : null, ...ids]
    );
    return result.affectedRows;
  }

  async getContractStats() {
    const [stats] = await this.pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_viewed = 0 THEN 1 ELSE 0 END) AS unviewed,
        SUM(CASE WHEN is_viewed = 1 THEN 1 ELSE 0 END) AS viewed
      FROM new_contracts
    `);
    const [statusStats] = await this.pool.execute(`
      SELECT status, COUNT(*) AS count
      FROM new_contracts
      GROUP BY status
    `);
    return { ...stats[0], byStatus: statusStats };
  }

  async listContracts(options) {
    const validSortFields = ['id', 'contract_address', 'chain_name', 'status', 'first_seen_at', 'contract_value'];
    const validSortDirections = ['asc', 'desc'];
    const orderField = validSortFields.includes(options.sortField) ? options.sortField : 'id';
    const orderDirection = validSortDirections.includes(String(options.sortDirection || '').toLowerCase())
      ? String(options.sortDirection).toUpperCase()
      : 'DESC';
    const conditions = [];
    const params = [];

    if (options.search) {
      const searchPattern = `%${String(options.search).toLowerCase()}%`;
      conditions.push('(LOWER(contract_address) LIKE ? OR LOWER(tx_hash) LIKE ? OR LOWER(deployer_address) LIKE ?)');
      params.push(searchPattern, searchPattern, searchPattern);
    }
    if (options.chain_name) {
      conditions.push('chain_name = ?');
      params.push(options.chain_name);
    }
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.is_viewed !== '' && options.is_viewed !== undefined) {
      conditions.push('is_viewed = ?');
      params.push(parseInt(options.is_viewed, 10));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRows] = await this.pool.execute(`SELECT COUNT(*) AS total FROM new_contracts ${whereClause}`, params);
    const [rows] = await this.pool.query(`
      SELECT
        id, contract_address, chain_name, tx_hash, deployer_address,
        status, function_count, success_call_count, fail_call_count,
        contract_value, analysis_result, is_viewed, remark,
        first_seen_at, created_at, updated_at
      FROM new_contracts
      ${whereClause}
      ORDER BY ${orderField} ${orderDirection}
      LIMIT ? OFFSET ?
    `, [...params, options.limit, options.offset]);

    return { total: countRows[0].total, rows };
  }

  async getContractById(id) {
    const [contracts] = await this.pool.execute('SELECT * FROM new_contracts WHERE id = ?', [id]);
    if (contracts.length === 0) {
      return null;
    }
    const [functions] = await this.pool.execute('SELECT * FROM contract_functions WHERE contract_id = ? ORDER BY selector', [id]);
    return { ...contracts[0], functions };
  }

  async updateContractStatus(id, status) {
    const [result] = await this.pool.execute(
      'UPDATE new_contracts SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );
    return result.affectedRows;
  }

  async updateContractViewed(id, isViewed) {
    const [result] = await this.pool.execute(
      'UPDATE new_contracts SET is_viewed = ?, updated_at = NOW() WHERE id = ?',
      [isViewed, id]
    );
    return result.affectedRows;
  }

  async updateContractRemark(id, remark) {
    const [result] = await this.pool.execute('UPDATE new_contracts SET remark = ? WHERE id = ?', [remark || null, id]);
    return result.affectedRows;
  }

  async getContractFunctions(id, filters) {
    let query = 'SELECT * FROM contract_functions WHERE contract_id = ?';
    const params = [id];
    const conditions = [];

    if (filters.type) {
      conditions.push('type = ?');
      params.push(filters.type);
    }
    if (filters.risk_flag !== undefined && filters.risk_flag !== '') {
      conditions.push('risk_flag = ?');
      params.push(parseInt(filters.risk_flag, 10));
    }
    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }

    const validSortFields = ['selector', 'name', 'type', 'call_count', 'risk_flag'];
    const orderField = validSortFields.includes(filters.sortField) ? filters.sortField : 'selector';
    const orderDirection = String(filters.sortDirection || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    query += ` ORDER BY ${orderField} ${orderDirection}`;

    const [rows] = await this.pool.execute(query, params);
    return rows;
  }
}

module.exports = LoraRepository;
