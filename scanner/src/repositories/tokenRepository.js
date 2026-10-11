function assertIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }

  return `\`${name}\``;
}

class TokenRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async testConnection() {
    const connection = await this.pool.getConnection();
    connection.release();
  }

  async getFactoryRow(factoryTable, factoryId) {
    const table = assertIdentifier(factoryTable);
    const sql = `SELECT * FROM ${table} WHERE Id = ? LIMIT 1`;
    const [rows] = await this.pool.execute(sql, [factoryId]);
    return rows[0] || null;
  }

  async updateFactoryPickIndex(factoryTable, factoryId, pickIndex) {
    const table = assertIdentifier(factoryTable);
    const sql = `UPDATE ${table} SET PickIndex = ? WHERE Id = ?`;
    await this.pool.execute(sql, [pickIndex, factoryId]);
  }

  async upsertToken(tokenTable, payload) {
    const table = assertIdentifier(tokenTable);
    const metricFields = Object.keys(payload.metrics);
    const quotedMetricFields = metricFields.map(assertIdentifier);
    const columns = [
      '`Id`',
      '`State`',
      '`Token`',
      '`Finish`',
      '`Balance`',
      ...quotedMetricFields
    ];

    const values = [
      payload.id,
      payload.state,
      payload.token,
      payload.finish,
      payload.balance,
      ...metricFields.map(field => payload.metrics[field])
    ];

    const placeholders = columns.map(() => '?').join(', ');
    const updates = [
      '`Token` = VALUES(`Token`)',
      '`Finish` = VALUES(`Finish`)',
      '`Balance` = VALUES(`Balance`)',
      ...quotedMetricFields.map(field => `${field} = VALUES(${field})`)
    ];

    const sql = `
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES (${placeholders})
      ON DUPLICATE KEY UPDATE ${updates.join(', ')}
    `;

    await this.pool.execute(sql, values);
  }

  async updateTokenMetrics(tokenTable, tokenId, payload) {
    const table = assertIdentifier(tokenTable);
    const metricFields = Object.keys(payload.metrics);
    const assignments = metricFields.map(field => `${assertIdentifier(field)} = ?`);
    const values = metricFields.map(field => payload.metrics[field]);

    const sql = `
      UPDATE ${table}
      SET ${assignments.join(', ')}, \`Finish\` = ?, \`Balance\` = ?
      WHERE \`Id\` = ?
    `;

    await this.pool.execute(sql, [...values, payload.finish, payload.balance, tokenId]);
  }

  async getStaleTokenIds(tokenTable, staleBefore, limit) {
    const table = assertIdentifier(tokenTable);
    const sql = `
      SELECT \`Id\`
      FROM ${table}
      WHERE \`Finish\` < ?
      ORDER BY \`Id\` DESC
      LIMIT ?
    `;

    const [rows] = await this.pool.execute(sql, [staleBefore, limit]);
    return rows.map(row => row.Id);
  }

  async getTopTokenIds(tokenTable, fields, perFieldLimit) {
    const table = assertIdentifier(tokenTable);
    const ids = new Set();

    for (const field of fields) {
      const quotedField = assertIdentifier(field);
      const sql = `
        SELECT \`Id\`
        FROM ${table}
        ORDER BY COALESCE(${quotedField}, 0) DESC
        LIMIT ?
      `;
      const [rows] = await this.pool.execute(sql, [perFieldLimit]);
      rows.forEach(row => ids.add(row.Id));
    }

    return Array.from(ids);
  }

  async listTokens(tokenTable, options) {
    const table = assertIdentifier(tokenTable);
    const validSortFields = ['Id', 'Token', 'State', 'WBNB', 'USDT', 'BUSD', 'WETH', 'USDC', 'Finish'];
    const validSortDirections = ['asc', 'desc'];
    const orderField = validSortFields.includes(options.sortField) ? options.sortField : 'Id';
    const orderDirection = validSortDirections.includes(String(options.sortDirection || '').toLowerCase())
      ? String(options.sortDirection).toUpperCase()
      : 'ASC';
    const conditions = [];
    const params = [];

    if (options.search) {
      const searchValue = `%${String(options.search).toLowerCase()}%`;
      conditions.push('(LOWER(Token) LIKE ? OR LOWER(Notes) LIKE ?)');
      params.push(searchValue, searchValue);
    }

    if (options.state !== '' && options.state !== undefined && options.state !== null) {
      conditions.push('State = ?');
      params.push(parseInt(options.state, 10));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const [countRows] = await this.pool.execute(`SELECT COUNT(*) AS total FROM ${table} ${whereClause}`, params);
    const [rows] = await this.pool.query(
      `SELECT * FROM ${table} ${whereClause} ORDER BY \`${orderField}\` ${orderDirection} LIMIT ? OFFSET ?`,
      [...params, options.limit, options.offset]
    );

    return {
      total: countRows[0].total,
      rows
    };
  }

  async getTokenById(tokenTable, id) {
    const table = assertIdentifier(tokenTable);
    const [rows] = await this.pool.execute(`SELECT * FROM ${table} WHERE Id = ?`, [id]);
    return rows[0] || null;
  }

  async updateTokenState(tokenTable, id, state) {
    const table = assertIdentifier(tokenTable);
    const [result] = await this.pool.execute(`UPDATE ${table} SET State = ? WHERE Id = ?`, [state, id]);
    return result.affectedRows;
  }

  async updateTokenNotes(tokenTable, id, notes) {
    const table = assertIdentifier(tokenTable);
    const [result] = await this.pool.execute(`UPDATE ${table} SET Notes = ? WHERE Id = ?`, [notes, id]);
    return result.affectedRows;
  }

  async batchUpdateTokenState(tokenTable, ids, state) {
    const table = assertIdentifier(tokenTable);
    const placeholders = ids.map(() => '?').join(', ');
    const [result] = await this.pool.execute(
      `UPDATE ${table} SET State = ? WHERE Id IN (${placeholders})`,
      [state, ...ids]
    );
    return result.affectedRows;
  }

  async getTokenStats(tokenTable) {
    const table = assertIdentifier(tokenTable);
    const [rows] = await this.pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN State = 0 THEN 1 ELSE 0 END) AS unaudited,
        SUM(CASE WHEN State = 1 THEN 1 ELSE 0 END) AS audited,
        SUM(COALESCE(WBNB, 0)) AS totalWBNB,
        SUM(COALESCE(USDT, 0)) AS totalUSDT,
        SUM(COALESCE(BUSD, 0)) AS totalBUSD,
        SUM(COALESCE(WETH, 0)) AS totalWETH,
        SUM(COALESCE(USDC, 0)) AS totalUSDC
      FROM ${table}
    `);
    return rows[0];
  }

  async migrateAveSchema() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS scanner_state (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        source_key VARCHAR(128) NOT NULL,
        last_block BIGINT UNSIGNED NOT NULL DEFAULT 0,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_scanner_state_chain_source (chain_id, source_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS scan_tokens (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        token_address VARCHAR(160) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        source VARCHAR(64) NOT NULL DEFAULT 'manual',
        first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_scanned_at DATETIME NULL,
        next_scan_at DATETIME NULL,
        last_status VARCHAR(32) NULL,
        last_error TEXT NULL,
        scan_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_scan_token_chain_address (chain_id, token_address),
        KEY idx_scan_tokens_due (chain_name, enabled, next_scan_at, last_scanned_at),
        KEY idx_scan_tokens_backfill (chain_name, chain_id, source, enabled, last_scanned_at, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS known_tokens (
        chain_id INT NOT NULL,
        token_address BINARY(20) NOT NULL,
        source VARCHAR(32) CHARACTER SET ascii NOT NULL DEFAULT 'dune',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chain_id, token_address)
      ) ENGINE=InnoDB
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS observed_pools (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        source_key VARCHAR(128) NOT NULL,
        protocol VARCHAR(32) NOT NULL,
        factory_address VARCHAR(160) NOT NULL,
        pool_address VARCHAR(160) NOT NULL,
        token0_address VARCHAR(160) NOT NULL,
        token1_address VARCHAR(160) NOT NULL,
        created_block BIGINT UNSIGNED NULL,
        liquidity_seen_at DATETIME NULL,
        last_liquidity_block BIGINT UNSIGNED NULL,
        liquidity_event_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_observed_pool_chain_address (chain_id, pool_address),
        KEY idx_observed_pool_source (chain_id, source_key),
        KEY idx_observed_pool_liquidity (chain_id, liquidity_seen_at),
        KEY idx_observed_pool_tokens (chain_id, token0_address, token1_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS observed_v4_pools (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        source_key VARCHAR(128) NOT NULL,
        pool_manager_address VARCHAR(160) NOT NULL,
        pool_id VARCHAR(160) NOT NULL,
        currency0_address VARCHAR(160) NOT NULL,
        currency1_address VARCHAR(160) NOT NULL,
        fee INT UNSIGNED NOT NULL,
        tick_spacing INT NOT NULL,
        hooks_address VARCHAR(160) NOT NULL,
        sqrt_price_x96 VARCHAR(160) NULL,
        tick INT NULL,
        initialized_block BIGINT UNSIGNED NULL,
        last_activity_block BIGINT UNSIGNED NULL,
        activity_event_count INT UNSIGNED NOT NULL DEFAULT 0,
        raw_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_observed_v4_pool_chain_id (chain_id, pool_id),
        KEY idx_observed_v4_pool_source (chain_id, source_key),
        KEY idx_observed_v4_pool_tokens (chain_id, currency0_address, currency1_address),
        KEY idx_observed_v4_pool_activity (chain_id, last_activity_block)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS token_liquidity (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        token_address VARCHAR(160) NOT NULL,
        token_id VARCHAR(160) NULL,
        ave_chain VARCHAR(64) NULL,
        name VARCHAR(255) NULL,
        symbol VARCHAR(128) NULL,
        decimal_count INT NULL,
        holders BIGINT NULL,
        current_price_usd DECIMAL(65, 30) NULL,
        price_change DECIMAL(65, 30) NULL,
        risk_level INT NULL,
        main_pair VARCHAR(160) NULL,
        main_pair_tvl DECIMAL(65, 30) NULL,
        is_audited TINYINT(1) NULL,
        resolved_pair VARCHAR(160) NULL,
        pairs_count INT NULL,
        liquidity_usd DECIMAL(65, 30) NULL,
        scan_status VARCHAR(32) NULL,
        raw_json JSON NULL,
        last_scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_token_liquidity_chain_address (chain_id, token_address),
        KEY idx_token_liquidity_main_pair_tvl (chain_name, main_pair_tvl),
        KEY idx_token_liquidity_scanned (chain_name, last_scanned_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS token_pairs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        token_address VARCHAR(160) NOT NULL,
        pair_address VARCHAR(160) NOT NULL,
        ave_chain VARCHAR(64) NULL,
        amm VARCHAR(128) NULL,
        token0_address VARCHAR(160) NULL,
        token0_symbol VARCHAR(128) NULL,
        token1_address VARCHAR(160) NULL,
        token1_symbol VARCHAR(128) NULL,
        reserve0 DECIMAL(65, 30) NULL,
        reserve1 DECIMAL(65, 30) NULL,
        token0_price_usd DECIMAL(65, 30) NULL,
        token1_price_usd DECIMAL(65, 30) NULL,
        pair_tvl_usd DECIMAL(65, 30) NULL,
        volume_u_24h DECIMAL(65, 30) NULL,
        tx_24h_count BIGINT NULL,
        lp_holders BIGINT NULL,
        lp_locked_percent DECIMAL(65, 30) NULL,
        raw_json JSON NULL,
        last_scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_token_pair_chain_token_pair (chain_id, token_address, pair_address),
        KEY idx_token_pairs_token (chain_id, token_address),
        KEY idx_token_pairs_pair (chain_id, pair_address),
        KEY idx_token_pairs_tvl (chain_name, pair_tvl_usd),
        KEY idx_token_pairs_volume (chain_name, volume_u_24h)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute('ALTER TABLE scan_tokens MODIFY COLUMN token_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE observed_pools MODIFY COLUMN factory_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE observed_pools MODIFY COLUMN pool_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE observed_pools MODIFY COLUMN token0_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE observed_pools MODIFY COLUMN token1_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE token_liquidity MODIFY COLUMN token_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE token_liquidity MODIFY COLUMN main_pair VARCHAR(160) NULL');
    await this.pool.execute('ALTER TABLE token_liquidity MODIFY COLUMN resolved_pair VARCHAR(160) NULL');
    await this.pool.execute('ALTER TABLE token_pairs MODIFY COLUMN token_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE token_pairs MODIFY COLUMN pair_address VARCHAR(160) NOT NULL');
    await this.pool.execute('ALTER TABLE token_pairs MODIFY COLUMN token0_address VARCHAR(160) NULL');
    await this.pool.execute('ALTER TABLE token_pairs MODIFY COLUMN token1_address VARCHAR(160) NULL');
    await this.ensureColumn(
      'token_liquidity',
      'liquidity_usd',
      'ALTER TABLE token_liquidity ADD COLUMN liquidity_usd DECIMAL(65, 30) NULL AFTER pairs_count'
    );
    await this.ensureColumn(
      'token_liquidity',
      'scan_status',
      'ALTER TABLE token_liquidity ADD COLUMN scan_status VARCHAR(32) NULL AFTER liquidity_usd'
    );
    await this.ensureIndex(
      'scan_tokens',
      'idx_scan_tokens_backfill',
      'CREATE INDEX idx_scan_tokens_backfill ON scan_tokens (chain_name, chain_id, source, enabled, last_scanned_at, id)'
    );
    await this.ensureIndex(
      'scan_tokens',
      'idx_scan_tokens_due_order',
      'CREATE INDEX idx_scan_tokens_due_order ON scan_tokens (chain_name, chain_id, enabled, last_scanned_at, next_scan_at, id)'
    );
    await this.ensureIndex(
      'scan_tokens',
      'idx_scan_tokens_due_source',
      'CREATE INDEX idx_scan_tokens_due_source ON scan_tokens (chain_name, chain_id, enabled, source, last_scanned_at, next_scan_at, id)'
    );
    await this.migrateProxyUpgradeSchema();
    await this.migrateContractAssetSchema();
  }

  async migrateContractAssetSchema() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS contract_assets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        contract_address VARCHAR(160) NOT NULL,
        asset_kind VARCHAR(64) NOT NULL DEFAULT 'contract',
        contract_type VARCHAR(128) NULL,
        source VARCHAR(64) NOT NULL DEFAULT 'manual',
        dataset VARCHAR(128) NULL,
        label VARCHAR(255) NULL,
        score DECIMAL(65, 30) NULL,
        is_known_token TINYINT(1) NULL,
        first_seen_at DATETIME NULL,
        last_seen_at DATETIME NULL,
        last_activity_at DATETIME NULL,
        last_token_activity_at DATETIME NULL,
        audit_action VARCHAR(64) NULL,
        audit_run_id VARCHAR(160) NULL,
        audit_error TEXT NULL,
        audited_at DATETIME NULL,
        metrics_json JSON NULL,
        raw_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_contract_assets_chain_address (chain_id, contract_address),
        KEY idx_contract_assets_score (chain_name, score),
        KEY idx_contract_assets_audit (chain_id, audit_action, score),
        KEY idx_contract_assets_known_token (chain_id, is_known_token),
        KEY idx_contract_assets_source (chain_id, source, dataset),
        KEY idx_contract_assets_activity (chain_name, last_activity_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute('ALTER TABLE contract_assets MODIFY COLUMN contract_address VARCHAR(160) NOT NULL');
    await this.ensureColumn(
      'contract_assets',
      'audit_action',
      'ALTER TABLE contract_assets ADD COLUMN audit_action VARCHAR(64) NULL AFTER last_token_activity_at'
    );
    await this.ensureColumn(
      'contract_assets',
      'audit_run_id',
      'ALTER TABLE contract_assets ADD COLUMN audit_run_id VARCHAR(160) NULL AFTER audit_action'
    );
    await this.ensureColumn(
      'contract_assets',
      'audit_error',
      'ALTER TABLE contract_assets ADD COLUMN audit_error TEXT NULL AFTER audit_run_id'
    );
    await this.ensureColumn(
      'contract_assets',
      'audited_at',
      'ALTER TABLE contract_assets ADD COLUMN audited_at DATETIME NULL AFTER audit_error'
    );
    await this.ensureIndex(
      'contract_assets',
      'idx_contract_assets_score',
      'CREATE INDEX idx_contract_assets_score ON contract_assets (chain_name, score)'
    );
    await this.ensureIndex(
      'contract_assets',
      'idx_contract_assets_audit',
      'CREATE INDEX idx_contract_assets_audit ON contract_assets (chain_id, audit_action, score)'
    );
    await this.ensureIndex(
      'contract_assets',
      'idx_contract_assets_known_token',
      'CREATE INDEX idx_contract_assets_known_token ON contract_assets (chain_id, is_known_token)'
    );
    await this.ensureIndex(
      'contract_assets',
      'idx_contract_assets_source',
      'CREATE INDEX idx_contract_assets_source ON contract_assets (chain_id, source, dataset)'
    );
    await this.ensureIndex(
      'contract_assets',
      'idx_contract_assets_activity',
      'CREATE INDEX idx_contract_assets_activity ON contract_assets (chain_name, last_activity_at)'
    );
  }

  async migrateProxyUpgradeSchema() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS token_proxy_state (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        token_address VARCHAR(160) NOT NULL,
        proxy_type VARCHAR(32) NOT NULL,
        implementation_address VARCHAR(160) NULL,
        first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_checked_block BIGINT UNSIGNED NULL,
        last_change_block BIGINT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_token_proxy_state_chain_token (chain_id, token_address),
        KEY idx_token_proxy_state_impl (chain_id, implementation_address)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS token_proxy_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        chain_name VARCHAR(32) NOT NULL,
        chain_id INT NOT NULL,
        token_address VARCHAR(160) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        old_implementation VARCHAR(160) NULL,
        new_implementation VARCHAR(160) NULL,
        tx_hash VARCHAR(160) NOT NULL,
        block_number BIGINT UNSIGNED NOT NULL,
        log_index BIGINT UNSIGNED NOT NULL,
        raw_json JSON NULL,
        qualified_as_token TINYINT(1) NOT NULL DEFAULT 1,
        liquidity_usd DECIMAL(65, 30) NULL,
        audit_action VARCHAR(64) NULL,
        audit_run_id VARCHAR(160) NULL,
        audit_error TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_token_proxy_event_log (chain_id, tx_hash, log_index),
        KEY idx_token_proxy_events_token (chain_id, token_address),
        KEY idx_token_proxy_events_block (chain_id, block_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async seedScanTokensBatch(chainConfig, tokenAddresses, source = 'env', options = {}) {
    const uniqueTokens = Array.from(new Set(
      (tokenAddresses || [])
        .map(tokenAddress => String(tokenAddress || '').trim().toLowerCase())
        .filter(Boolean)
    ));
    if (uniqueTokens.length === 0) {
      return 0;
    }

    const delaySeconds = Math.max(0, Math.floor(Number(options.delayMs || 0) / 1000));
    const reschedule = Boolean(options.reschedule);
    const rowPlaceholder = delaySeconds > 0
      ? '(?, ?, LOWER(?), ?, DATE_ADD(NOW(), INTERVAL ? SECOND))'
      : '(?, ?, LOWER(?), ?, NULL)';
    const placeholders = uniqueTokens.map(() => rowPlaceholder).join(', ');
    const params = [];

    for (const tokenAddress of uniqueTokens) {
      params.push(chainConfig.key, chainConfig.chainId, tokenAddress, source);
      if (delaySeconds > 0) {
        params.push(delaySeconds);
      }
    }

    const updates = delaySeconds > 0
      ? reschedule
        ? `
            enabled = 1,
            source = VALUES(source),
            next_scan_at = CASE
              WHEN next_scan_at IS NULL OR next_scan_at > VALUES(next_scan_at) THEN VALUES(next_scan_at)
              ELSE next_scan_at
            END,
            updated_at = NOW()
        `
        : `
            enabled = 1,
            source = VALUES(source),
            next_scan_at = CASE
              WHEN scan_count = 0 AND last_scanned_at IS NULL THEN VALUES(next_scan_at)
              ELSE next_scan_at
            END,
            updated_at = NOW()
        `
      : `
          enabled = 1,
          source = VALUES(source),
          updated_at = NOW()
        `;

    const [result] = await this.pool.query(
      `
        INSERT INTO scan_tokens (chain_name, chain_id, token_address, source, next_scan_at)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE ${updates}
      `,
      params
    );

    return result.affectedRows;
  }

  async getContractAssetsForAudit(chainConfig, options = {}) {
    const safeLimit = Math.max(1, Number.parseInt(options.limit, 10) || 100);
    const source = String(options.source || '').trim();
    const dataset = String(options.dataset || '').trim();
    const onlyNonToken = options.onlyNonToken !== false;
    const includeSubmitted = Boolean(options.includeSubmitted);
    const conditions = [
      'chain_id = ?'
    ];
    const params = [chainConfig.chainId];

    if (source) {
      conditions.push('source = ?');
      params.push(source);
    }
    if (dataset) {
      conditions.push('dataset = ?');
      params.push(dataset);
    }
    if (onlyNonToken) {
      conditions.push('(is_known_token = 0 OR is_known_token IS NULL)');
    }
    if (!includeSubmitted) {
      conditions.push('(audit_action IS NULL OR audit_action IN (\'failed\', \'missing_config\', \'missing_rpc_url\'))');
    }

    const [rows] = await this.pool.execute(
      `
        SELECT id, chain_name, chain_id, contract_address, score, is_known_token, audit_action
        FROM contract_assets
        WHERE ${conditions.join(' AND ')}
        ORDER BY score DESC, id ASC
        LIMIT ${safeLimit}
      `,
      params
    );

    return rows;
  }

  async updateContractAssetAudit(assetId, payload) {
    await this.pool.execute(
      `
        UPDATE contract_assets
        SET audit_action = ?,
            audit_run_id = ?,
            audit_error = ?,
            audited_at = NOW(),
            updated_at = NOW()
        WHERE id = ?
      `,
      [
        payload.auditAction || null,
        payload.auditRunId || null,
        payload.auditError ? String(payload.auditError).slice(0, 2000) : null,
        assetId
      ]
    );
  }

  async seedScanTokens(chainConfig, tokenAddresses, source = 'env', options = {}) {
    return this.seedScanTokensBatch(chainConfig, tokenAddresses, source, options);
  }

  async upsertObservedPools(chainConfig, pools) {
    let affected = 0;
    for (const pool of pools) {
      if (!pool.poolAddress || !pool.token0 || !pool.token1) {
        continue;
      }

      const [result] = await this.pool.execute(
        `
          INSERT INTO observed_pools (
            chain_name, chain_id, source_key, protocol, factory_address,
            pool_address, token0_address, token1_address, created_block
          )
          VALUES (?, ?, ?, ?, LOWER(?), LOWER(?), LOWER(?), LOWER(?), ?)
          ON DUPLICATE KEY UPDATE
            source_key = VALUES(source_key),
            protocol = VALUES(protocol),
            factory_address = VALUES(factory_address),
            token0_address = VALUES(token0_address),
            token1_address = VALUES(token1_address),
            created_block = COALESCE(created_block, VALUES(created_block)),
            updated_at = NOW()
        `,
        [
          chainConfig.key,
          chainConfig.chainId,
          pool.sourceKey,
          pool.protocol,
          pool.factoryAddress,
          pool.poolAddress,
          pool.token0,
          pool.token1,
          pool.createdBlock || null
        ]
      );
      affected += result.affectedRows === 1 ? 1 : 0;
    }

    return affected;
  }

  async upsertObservedV4Pools(chainConfig, pools) {
    let affected = 0;
    for (const pool of pools || []) {
      if (!pool.poolId || !pool.currency0 || !pool.currency1 || !pool.poolManagerAddress) {
        continue;
      }

      const [result] = await this.pool.execute(
        `
          INSERT INTO observed_v4_pools (
            chain_name, chain_id, source_key, pool_manager_address, pool_id,
            currency0_address, currency1_address, fee, tick_spacing, hooks_address,
            sqrt_price_x96, tick, initialized_block, raw_json
          )
          VALUES (?, ?, ?, LOWER(?), LOWER(?), LOWER(?), LOWER(?), ?, ?, LOWER(?), ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            source_key = VALUES(source_key),
            pool_manager_address = VALUES(pool_manager_address),
            currency0_address = VALUES(currency0_address),
            currency1_address = VALUES(currency1_address),
            fee = VALUES(fee),
            tick_spacing = VALUES(tick_spacing),
            hooks_address = VALUES(hooks_address),
            sqrt_price_x96 = VALUES(sqrt_price_x96),
            tick = VALUES(tick),
            initialized_block = COALESCE(initialized_block, VALUES(initialized_block)),
            raw_json = VALUES(raw_json),
            updated_at = NOW()
        `,
        [
          chainConfig.key,
          chainConfig.chainId,
          pool.sourceKey,
          pool.poolManagerAddress,
          pool.poolId,
          pool.currency0,
          pool.currency1,
          Number(pool.fee || 0),
          Number(pool.tickSpacing || 0),
          pool.hooksAddress || '0x0000000000000000000000000000000000000000',
          pool.sqrtPriceX96 === undefined || pool.sqrtPriceX96 === null ? null : String(pool.sqrtPriceX96),
          pool.tick === undefined || pool.tick === null ? null : Number(pool.tick),
          pool.initializedBlock || null,
          JSON.stringify(pool.raw || null)
        ]
      );
      affected += result.affectedRows === 1 ? 1 : 0;
    }

    return affected;
  }

  async getObservedV4PoolsByIds(chainConfig, poolIds) {
    const normalized = Array.from(new Set(
      (poolIds || [])
        .map(poolId => String(poolId || '').toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) {
      return new Map();
    }

    const placeholders = normalized.map(() => '?').join(', ');
    const [rows] = await this.pool.execute(
      `
        SELECT *
        FROM observed_v4_pools
        WHERE chain_id = ?
          AND pool_id IN (${placeholders})
      `,
      [chainConfig.chainId, ...normalized]
    );

    return new Map(rows.map(row => [String(row.pool_id).toLowerCase(), row]));
  }

  async markObservedV4PoolActivity(chainConfig, poolId, blockNumber) {
    await this.pool.execute(
      `
        UPDATE observed_v4_pools
        SET last_activity_block = ?,
            activity_event_count = activity_event_count + 1,
            updated_at = NOW()
        WHERE chain_id = ? AND pool_id = LOWER(?)
      `,
      [blockNumber || null, chainConfig.chainId, poolId]
    );
  }

  async getObservedPoolsByAddresses(chainConfig, poolAddresses) {
    const normalized = Array.from(new Set(
      (poolAddresses || [])
        .map(address => String(address || '').toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) {
      return new Map();
    }

    const placeholders = normalized.map(() => '?').join(', ');
    const [rows] = await this.pool.execute(
      `
        SELECT *
        FROM observed_pools
        WHERE chain_id = ?
          AND pool_address IN (${placeholders})
      `,
      [chainConfig.chainId, ...normalized]
    );

    return new Map(rows.map(row => [String(row.pool_address).toLowerCase(), row]));
  }

  async isKnownTokenAsset(chainConfig, tokenAddress, ignoredTokens = []) {
    const normalizedToken = String(tokenAddress || '').toLowerCase();
    if (!normalizedToken) {
      return false;
    }

    const ignored = new Set((ignoredTokens || []).map(token => String(token || '').toLowerCase()));
    if (ignored.has(normalizedToken)) {
      return false;
    }

    if (/^0x[0-9a-f]{40}$/.test(normalizedToken)) {
      const [knownRows] = await this.pool.execute(
        `
          SELECT 1
          FROM known_tokens
          WHERE chain_id = ? AND token_address = UNHEX(SUBSTRING(?, 3))
          LIMIT 1
        `,
        [chainConfig.chainId, normalizedToken]
      );
      if (knownRows.length > 0) {
        return true;
      }
    }

    const [rows] = await this.pool.execute(
      `
        SELECT 1
        FROM scan_tokens
        WHERE chain_id = ? AND token_address = ?
        LIMIT 1
      `,
      [chainConfig.chainId, normalizedToken]
    );
    if (rows.length > 0) {
      return true;
    }

    const [liquidityRows] = await this.pool.execute(
      `
        SELECT 1
        FROM token_liquidity
        WHERE chain_id = ? AND token_address = ?
        LIMIT 1
      `,
      [chainConfig.chainId, normalizedToken]
    );
    if (liquidityRows.length > 0) {
      return true;
    }

    const [poolRows] = await this.pool.execute(
      `
        SELECT 1
        FROM observed_pools
        WHERE chain_id = ?
          AND (token0_address = ? OR token1_address = ?)
        LIMIT 1
      `,
      [chainConfig.chainId, normalizedToken, normalizedToken]
    );

    return poolRows.length > 0;
  }

  async getKnownTokenAssetMap(chainConfig, tokenAddresses) {
    const normalized = Array.from(new Set(
      (tokenAddresses || [])
        .map(address => String(address || '').trim().toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) {
      return new Map();
    }

    const placeholders = normalized.map(() => '?').join(', ');
    const evmAddresses = normalized.filter(address => /^0x[0-9a-f]{40}$/.test(address));
    const knownPlaceholders = evmAddresses.map(() => 'UNHEX(SUBSTRING(?, 3))').join(', ');
    const knownUnion = evmAddresses.length > 0
      ? `
        SELECT CONCAT('0x', LOWER(HEX(token_address))) AS address_value
        FROM known_tokens
        WHERE chain_id = ? AND token_address IN (${knownPlaceholders})
        UNION
      `
      : '';
    const [rows] = await this.pool.execute(
      `
        ${knownUnion}
        SELECT token_address AS address_value
        FROM scan_tokens
        WHERE chain_id = ? AND token_address IN (${placeholders})
        UNION
        SELECT token_address AS address_value
        FROM token_liquidity
        WHERE chain_id = ? AND token_address IN (${placeholders})
        UNION
        SELECT token0_address AS address_value
        FROM observed_pools
        WHERE chain_id = ?
          AND (token0_address IN (${placeholders}) OR token1_address IN (${placeholders}))
        UNION
        SELECT token1_address AS address_value
        FROM observed_pools
        WHERE chain_id = ?
          AND (token0_address IN (${placeholders}) OR token1_address IN (${placeholders}))
      `,
      [
        ...(evmAddresses.length > 0 ? [chainConfig.chainId, ...evmAddresses] : []),
        chainConfig.chainId,
        ...normalized,
        chainConfig.chainId,
        ...normalized,
        chainConfig.chainId,
        ...normalized,
        ...normalized,
        chainConfig.chainId,
        ...normalized,
        ...normalized
      ]
    );

    return new Map(rows.map(row => [String(row.address_value || '').toLowerCase(), true]));
  }

  async upsertContractAssetsBatch(chainConfig, assets) {
    const normalizedAssets = (assets || [])
      .map(asset => ({
        ...asset,
        contractAddress: String(asset.contractAddress || '').trim().toLowerCase()
      }))
      .filter(asset => asset.contractAddress);

    if (normalizedAssets.length === 0) {
      return 0;
    }

    const rowPlaceholder = '(?, ?, LOWER(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const placeholders = normalizedAssets.map(() => rowPlaceholder).join(', ');
    const params = [];

    for (const asset of normalizedAssets) {
      params.push(
        chainConfig.key,
        chainConfig.chainId,
        asset.contractAddress,
        asset.assetKind || 'contract',
        asset.contractType || null,
        asset.source || 'manual',
        asset.dataset || null,
        asset.label || null,
        this.nullableNumber(asset.score),
        asset.isKnownToken === undefined || asset.isKnownToken === null ? null : Number(Boolean(asset.isKnownToken)),
        asset.firstSeenAt || null,
        asset.lastSeenAt || null,
        asset.lastActivityAt || null,
        asset.lastTokenActivityAt || null,
        JSON.stringify(asset.metrics || null),
        JSON.stringify(asset.raw || null)
      );
    }

    const [result] = await this.pool.query(
      `
        INSERT INTO contract_assets (
          chain_name, chain_id, contract_address, asset_kind, contract_type,
          source, dataset, label, score, is_known_token, first_seen_at,
          last_seen_at, last_activity_at, last_token_activity_at, metrics_json, raw_json
        )
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE
          chain_name = VALUES(chain_name),
          asset_kind = VALUES(asset_kind),
          contract_type = VALUES(contract_type),
          source = VALUES(source),
          dataset = VALUES(dataset),
          label = VALUES(label),
          score = VALUES(score),
          is_known_token = VALUES(is_known_token),
          first_seen_at = COALESCE(LEAST(first_seen_at, VALUES(first_seen_at)), first_seen_at, VALUES(first_seen_at)),
          last_seen_at = COALESCE(GREATEST(last_seen_at, VALUES(last_seen_at)), last_seen_at, VALUES(last_seen_at)),
          last_activity_at = COALESCE(GREATEST(last_activity_at, VALUES(last_activity_at)), last_activity_at, VALUES(last_activity_at)),
          last_token_activity_at = COALESCE(GREATEST(last_token_activity_at, VALUES(last_token_activity_at)), last_token_activity_at, VALUES(last_token_activity_at)),
          metrics_json = VALUES(metrics_json),
          raw_json = VALUES(raw_json),
          updated_at = NOW()
      `,
      params
    );

    return result.affectedRows;
  }

  async markObservedPoolLiquidity(chainConfig, poolAddress, blockNumber) {
    await this.pool.execute(
      `
        UPDATE observed_pools
        SET liquidity_seen_at = COALESCE(liquidity_seen_at, NOW()),
            last_liquidity_block = ?,
            liquidity_event_count = liquidity_event_count + 1,
            updated_at = NOW()
        WHERE chain_id = ? AND pool_address = LOWER(?)
      `,
      [blockNumber || null, chainConfig.chainId, poolAddress]
    );
  }

  async getScannerState(chainConfig, sourceKey) {
    const [rows] = await this.pool.execute(
      `
        SELECT *
        FROM scanner_state
        WHERE chain_id = ? AND source_key = ?
        LIMIT 1
      `,
      [chainConfig.chainId, sourceKey]
    );

    return rows[0] || null;
  }

  async upsertScannerState(chainConfig, sourceKey, lastBlock, metadata = {}) {
    await this.pool.execute(
      `
        INSERT INTO scanner_state (chain_name, chain_id, source_key, last_block, metadata)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          chain_name = VALUES(chain_name),
          last_block = VALUES(last_block),
          metadata = VALUES(metadata),
          updated_at = NOW()
      `,
      [chainConfig.key, chainConfig.chainId, sourceKey, lastBlock, JSON.stringify(metadata)]
    );
  }

  async getDueScanTokens(chainConfig, limit) {
    const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 100);
    const dueSourcePrefix = String(chainConfig.scan?.dueSourcePrefix || '').trim();
    const sourceCondition = dueSourcePrefix ? 'AND source LIKE ?' : '';
    const sourceParams = dueSourcePrefix ? [`${dueSourcePrefix}%`] : [];
    const dueUpdatedAfter = chainConfig.scan?.dueUpdatedAfter instanceof Date
      ? Math.floor(chainConfig.scan.dueUpdatedAfter.getTime() / 1000)
      : Number(chainConfig.scan?.dueUpdatedAfter || 0);
    const updatedAfterCondition = dueUpdatedAfter > 0 ? 'AND updated_at >= FROM_UNIXTIME(?)' : '';
    const updatedAfterParams = dueUpdatedAfter > 0 ? [dueUpdatedAfter] : [];
    const indexName = dueSourcePrefix ? 'idx_scan_tokens_due_source' : 'idx_scan_tokens_due_order';
    const [unscannedRows] = await this.pool.execute(
      `
        SELECT id, chain_name, chain_id, token_address
        FROM scan_tokens FORCE INDEX (${indexName})
        WHERE chain_name = ?
          AND chain_id = ?
          AND enabled = 1
          ${sourceCondition}
          ${updatedAfterCondition}
          AND last_scanned_at IS NULL
          AND (next_scan_at IS NULL OR next_scan_at <= NOW())
        ORDER BY id ASC
        LIMIT ${safeLimit}
      `,
      [chainConfig.key, chainConfig.chainId, ...sourceParams, ...updatedAfterParams]
    );

    if (unscannedRows.length >= safeLimit) {
      return unscannedRows;
    }

    const remaining = safeLimit - unscannedRows.length;
    const [scannedRows] = await this.pool.execute(
      `
        SELECT id, chain_name, chain_id, token_address
        FROM scan_tokens FORCE INDEX (${indexName})
        WHERE chain_name = ?
          AND chain_id = ?
          AND enabled = 1
          ${sourceCondition}
          ${updatedAfterCondition}
          AND last_scanned_at IS NOT NULL
          AND (next_scan_at IS NULL OR next_scan_at <= NOW())
        ORDER BY last_scanned_at ASC, id ASC
        LIMIT ${remaining}
      `,
      [chainConfig.key, chainConfig.chainId, ...sourceParams, ...updatedAfterParams]
    );

    return [...unscannedRows, ...scannedRows];
  }

  async getBackfillScanTokens(chainConfig, options = {}) {
    const safeLimit = Math.max(1, Number.parseInt(options.limit, 10) || 100);
    const includeErrors = Boolean(options.includeErrors);
    const force = Boolean(options.force);
    const source = options.source || '';
    const retryErrorLike = String(options.retryErrorLike || '').trim();
    const conditions = [
      'st.chain_name = ?',
      'st.chain_id = ?',
      'st.enabled = 1'
    ];
    const params = [chainConfig.key, chainConfig.chainId];

    if (source) {
      conditions.push('st.source = ?');
      params.push(source);
    }

    if (retryErrorLike) {
      conditions.push("st.last_status = 'error'");
      conditions.push('st.last_error LIKE ?');
      params.push(`%${retryErrorLike}%`);
    }

    if (!force && !retryErrorLike) {
      if (options.unscannedOnly !== false) {
        conditions.push('st.last_scanned_at IS NULL');
      } else {
        conditions.push('tl.id IS NULL');
      }
    }

    if (!includeErrors && !retryErrorLike) {
      conditions.push("(st.last_status IS NULL OR st.last_status <> 'error')");
    }

    const joinClause = !force && options.unscannedOnly === false
      ? `
        SELECT st.id, st.chain_name, st.chain_id, st.token_address
        FROM scan_tokens st
        LEFT JOIN token_liquidity tl
          ON tl.chain_id = st.chain_id
         AND tl.token_address = st.token_address
      `
      : `
        SELECT st.id, st.chain_name, st.chain_id, st.token_address
        FROM scan_tokens st FORCE INDEX (idx_scan_tokens_backfill)
      `;
    const orderClause = !force && options.unscannedOnly !== false && !retryErrorLike
      ? 'st.id ASC'
      : `
          CASE WHEN st.last_scanned_at IS NULL THEN 0 ELSE 1 END,
          COALESCE(st.last_scanned_at, '1970-01-01') ASC,
          st.id ASC
        `;

    const [rows] = await this.pool.execute(
      `
        ${joinClause}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderClause}
        LIMIT ${safeLimit}
      `,
      params
    );

    return rows;
  }

  async saveAveLiquidityResult(chainConfig, tokenAddress, response, options = {}) {
    const normalizedToken = String(tokenAddress).toLowerCase();
    const token = response?.data?.token || {};
    const resolvedPair = response?.resolvedPair || {};
    const pairs = Array.isArray(response?.data?.pairs) ? response.data.pairs : [];
    const scannedAt = new Date();
    const persistDetails = Boolean(chainConfig.scan?.persistLiquidityDetails);
    const rawJson = persistDetails ? JSON.stringify(response || null) : null;

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      if (persistDetails) {
        await connection.execute(
          `
          INSERT INTO token_liquidity (
            chain_name, chain_id, token_address, token_id, ave_chain, name, symbol,
            decimal_count, holders, current_price_usd, price_change, risk_level,
            main_pair, main_pair_tvl, is_audited, resolved_pair, pairs_count,
            raw_json, last_scanned_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            token_id = COALESCE(VALUES(token_id), token_id),
            ave_chain = COALESCE(VALUES(ave_chain), ave_chain),
            name = COALESCE(VALUES(name), name),
            symbol = COALESCE(VALUES(symbol), symbol),
            decimal_count = COALESCE(VALUES(decimal_count), decimal_count),
            holders = COALESCE(VALUES(holders), holders),
            current_price_usd = COALESCE(VALUES(current_price_usd), current_price_usd),
            price_change = COALESCE(VALUES(price_change), price_change),
            risk_level = COALESCE(VALUES(risk_level), risk_level),
            main_pair = COALESCE(VALUES(main_pair), main_pair),
            main_pair_tvl = COALESCE(VALUES(main_pair_tvl), main_pair_tvl),
            is_audited = COALESCE(VALUES(is_audited), is_audited),
            resolved_pair = COALESCE(VALUES(resolved_pair), resolved_pair),
            pairs_count = VALUES(pairs_count),
            raw_json = VALUES(raw_json),
            last_scanned_at = VALUES(last_scanned_at)
          `,
          [
          chainConfig.key,
          chainConfig.chainId,
          normalizedToken,
          response?.tokenId || null,
          token.chain || resolvedPair.chain || null,
          token.name || null,
          token.symbol || null,
          this.nullableNumber(token.decimal),
          this.nullableNumber(token.holders),
          this.nullableNumber(token.current_price_usd),
          this.nullableNumber(token.price_change),
          this.nullableNumber(token.risk_level),
          token.main_pair || null,
          this.nullableNumber(token.main_pair_tvl),
          typeof response?.data?.is_audited === 'boolean' ? Number(response.data.is_audited) : null,
          resolvedPair.pair || null,
          pairs.length,
          rawJson,
          scannedAt
          ]
        );
      } else {
        await connection.execute(
          `
            INSERT INTO token_liquidity (
              chain_name, chain_id, token_address, pairs_count,
              liquidity_usd, scan_status, raw_json, last_scanned_at
            )
            VALUES (?, ?, ?, ?, ?, 'success', NULL, ?)
            ON DUPLICATE KEY UPDATE
              pairs_count = VALUES(pairs_count),
              liquidity_usd = VALUES(liquidity_usd),
              scan_status = VALUES(scan_status),
              raw_json = NULL,
              last_scanned_at = VALUES(last_scanned_at)
          `,
          [
            chainConfig.key,
            chainConfig.chainId,
            normalizedToken,
            pairs.length,
            this.nullableNumber(options.liquidityUsd),
            scannedAt
          ]
        );
      }

      if (persistDetails) {
        await connection.execute(
          'DELETE FROM token_pairs WHERE chain_id = ? AND token_address = ?',
          [chainConfig.chainId, normalizedToken]
        );
      }

      for (const pair of persistDetails ? pairs : []) {
        if (!pair.pair) {
          continue;
        }

        await connection.execute(
          `
            INSERT INTO token_pairs (
              chain_name, chain_id, token_address, pair_address, ave_chain, amm,
              token0_address, token0_symbol, token1_address, token1_symbol,
              reserve0, reserve1, token0_price_usd, token1_price_usd, pair_tvl_usd,
              volume_u_24h, tx_24h_count, lp_holders, lp_locked_percent,
              raw_json, last_scanned_at
            )
            VALUES (?, ?, ?, LOWER(?), ?, ?, LOWER(?), ?, LOWER(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              ave_chain = VALUES(ave_chain),
              amm = VALUES(amm),
              token0_address = VALUES(token0_address),
              token0_symbol = VALUES(token0_symbol),
              token1_address = VALUES(token1_address),
              token1_symbol = VALUES(token1_symbol),
              reserve0 = VALUES(reserve0),
              reserve1 = VALUES(reserve1),
              token0_price_usd = VALUES(token0_price_usd),
              token1_price_usd = VALUES(token1_price_usd),
              pair_tvl_usd = VALUES(pair_tvl_usd),
              volume_u_24h = VALUES(volume_u_24h),
              tx_24h_count = VALUES(tx_24h_count),
              lp_holders = VALUES(lp_holders),
              lp_locked_percent = VALUES(lp_locked_percent),
              raw_json = VALUES(raw_json),
              last_scanned_at = VALUES(last_scanned_at)
          `,
          [
            chainConfig.key,
            chainConfig.chainId,
            normalizedToken,
            pair.pair,
            pair.chain || null,
            pair.amm || null,
            pair.token0_address || '',
            pair.token0_symbol || null,
            pair.token1_address || '',
            pair.token1_symbol || null,
            this.nullableNumber(pair.reserve0),
            this.nullableNumber(pair.reserve1),
            this.nullableNumber(pair.token0_price_usd),
            this.nullableNumber(pair.token1_price_usd),
            this.computePairTvlUsd(pair),
            this.nullableNumber(pair.volume_u_24h),
            this.nullableNumber(pair.tx_24h_count),
            this.nullableNumber(pair.lp_holders),
            this.nullableNumber(pair.lp_locked_percent),
            JSON.stringify(pair),
            scannedAt
          ]
        );
      }

      await connection.execute(
        `
          UPDATE scan_tokens
          SET last_scanned_at = ?,
              next_scan_at = DATE_ADD(?, INTERVAL ? SECOND),
              last_status = 'success',
              last_error = NULL,
              scan_count = scan_count + 1
          WHERE chain_id = ? AND token_address = ?
        `,
        [
          scannedAt,
          scannedAt,
          Math.floor((chainConfig.scan.rescanIntervalMs || chainConfig.scan.staleAfterMs || 3600000) / 1000),
          chainConfig.chainId,
          normalizedToken
        ]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markAveLiquidityFailure(chainConfig, tokenAddress, error, retryDelayMs) {
    await this.pool.execute(
      `
        UPDATE scan_tokens
        SET last_scanned_at = NOW(),
            next_scan_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
            last_status = 'error',
            last_error = ?,
            scan_count = scan_count + 1
        WHERE chain_id = ? AND token_address = LOWER(?)
      `,
      [
        Math.max(1, Math.floor(retryDelayMs / 1000)),
        String(error.message || error).slice(0, 2000),
        chainConfig.chainId,
        tokenAddress
      ]
    );
  }

  async markScanTokenAuditComplete(chainConfig, tokenAddress, status) {
    await this.pool.execute(
      `
        UPDATE scan_tokens
        SET enabled = 0,
            next_scan_at = NULL,
            last_status = ?,
            last_error = NULL,
            updated_at = NOW()
        WHERE chain_id = ? AND token_address = LOWER(?)
      `,
      [String(status || 'audit_complete').slice(0, 32), chainConfig.chainId, tokenAddress]
    );
    await this.pool.execute(
      `
        UPDATE token_liquidity
        SET scan_status = ?, updated_at = NOW()
        WHERE chain_id = ? AND token_address = LOWER(?)
      `,
      [String(status || 'audit_complete').slice(0, 32), chainConfig.chainId, tokenAddress]
    );
  }

  async markScanTokenIgnored(chainConfig, tokenAddress, reason = 'ignored') {
    await this.pool.execute(
      `
        UPDATE scan_tokens
        SET enabled = 0,
            last_scanned_at = NOW(),
            next_scan_at = NULL,
            last_status = 'ignored',
            last_error = ?,
            scan_count = scan_count + 1,
            updated_at = NOW()
        WHERE chain_id = ? AND token_address = LOWER(?)
      `,
      [String(reason).slice(0, 2000), chainConfig.chainId, tokenAddress]
    );
  }

  async disableScanTokensBatch(chainConfig, tokenAddresses, reason = 'ignored') {
    const normalized = Array.from(new Set(
      (tokenAddresses || [])
        .map(tokenAddress => String(tokenAddress || '').trim().toLowerCase())
        .filter(Boolean)
    ));
    if (normalized.length === 0) {
      return 0;
    }

    const placeholders = normalized.map(() => '?').join(', ');
    const [result] = await this.pool.execute(
      `
        UPDATE scan_tokens
        SET enabled = 0,
            next_scan_at = NULL,
            last_status = 'ignored',
            last_error = ?,
            updated_at = NOW()
        WHERE chain_id = ?
          AND token_address IN (${placeholders})
      `,
      [String(reason).slice(0, 2000), chainConfig.chainId, ...normalized]
    );

    return result.affectedRows;
  }

  async getTokenProxyState(chainConfig, tokenAddress) {
    const [rows] = await this.pool.execute(
      `
        SELECT *
        FROM token_proxy_state
        WHERE chain_id = ? AND token_address = LOWER(?)
        LIMIT 1
      `,
      [chainConfig.chainId, tokenAddress]
    );
    return rows[0] || null;
  }

  async upsertTokenProxyState(chainConfig, payload) {
    await this.pool.execute(
      `
        INSERT INTO token_proxy_state (
          chain_name, chain_id, token_address, proxy_type, implementation_address,
          last_checked_block, last_change_block
        )
        VALUES (?, ?, LOWER(?), ?, LOWER(?), ?, ?)
        ON DUPLICATE KEY UPDATE
          proxy_type = VALUES(proxy_type),
          implementation_address = VALUES(implementation_address),
          last_checked_block = VALUES(last_checked_block),
          last_change_block = COALESCE(VALUES(last_change_block), last_change_block),
          updated_at = NOW()
      `,
      [
        chainConfig.key,
        chainConfig.chainId,
        payload.tokenAddress,
        payload.proxyType || 'erc1967',
        payload.implementationAddress || null,
        payload.lastCheckedBlock || null,
        payload.lastChangeBlock || null
      ]
    );
  }

  async insertTokenProxyEvent(chainConfig, payload) {
    const [result] = await this.pool.execute(
      `
        INSERT INTO token_proxy_events (
          chain_name, chain_id, token_address, event_type, old_implementation,
          new_implementation, tx_hash, block_number, log_index, raw_json,
          qualified_as_token, audit_action
        )
        VALUES (?, ?, LOWER(?), ?, LOWER(?), LOWER(?), LOWER(?), ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
      `,
      [
        chainConfig.key,
        chainConfig.chainId,
        payload.tokenAddress,
        payload.eventType || 'Upgraded',
        payload.oldImplementation || null,
        payload.newImplementation || null,
        payload.txHash,
        payload.blockNumber,
        payload.logIndex,
        JSON.stringify(payload.rawJson || null),
        payload.qualifiedAsToken === false ? 0 : 1,
        payload.auditAction || 'pending'
      ]
    );

    return {
      id: result.insertId,
      inserted: result.affectedRows === 1
    };
  }

  async updateTokenProxyEventAudit(eventId, payload) {
    await this.pool.execute(
      `
        UPDATE token_proxy_events
        SET liquidity_usd = ?,
            audit_action = ?,
            audit_run_id = ?,
            audit_error = ?,
            updated_at = NOW()
        WHERE id = ?
      `,
      [
        this.nullableNumber(payload.liquidityUsd),
        payload.auditAction || null,
        payload.auditRunId || null,
        payload.auditError ? String(payload.auditError).slice(0, 2000) : null,
        eventId
      ]
    );
  }

  nullableNumber(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? String(value) : null;
  }

  computePairTvlUsd(pair) {
    const reserve0 = Number(pair.reserve0);
    const reserve1 = Number(pair.reserve1);
    const price0 = Number(pair.token0_price_usd);
    const price1 = Number(pair.token1_price_usd);
    const tvl = reserve0 * price0 + reserve1 * price1;

    return Number.isFinite(tvl) ? String(tvl) : null;
  }

  async ensureIndex(tableName, indexName, createSql) {
    const [rows] = await this.pool.execute(
      `
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND index_name = ?
        LIMIT 1
      `,
      [tableName, indexName]
    );
    if (rows.length > 0) {
      return;
    }

    await this.pool.execute(createSql);
  }

  async ensureColumn(tableName, columnName, alterSql) {
    const [rows] = await this.pool.execute(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
      `,
      [tableName, columnName]
    );
    if (rows.length > 0) {
      return;
    }

    await this.pool.execute(alterSql);
  }
}

module.exports = TokenRepository;
