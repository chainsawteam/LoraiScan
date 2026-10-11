USE `lora`;

CREATE TABLE IF NOT EXISTS `contract_audits` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  `chain_id` INT NOT NULL COMMENT '链ID',
  `contract_address` VARCHAR(128) NOT NULL COMMENT '合约地址，小写存储',
  `chain_name` VARCHAR(50) NOT NULL COMMENT '链名称',
  `remote_run_id` VARCHAR(128) DEFAULT NULL COMMENT '第三方审计 run_id',
  `remote_status` VARCHAR(50) DEFAULT NULL COMMENT '第三方审计状态',
  `remote_phase` VARCHAR(100) DEFAULT NULL COMMENT '第三方当前阶段',
  `latest_summary` TEXT DEFAULT NULL COMMENT '第三方最新摘要',
  `last_error` TEXT DEFAULT NULL COMMENT '最近一次错误',
  `last_lookup_at` DATETIME DEFAULT NULL COMMENT '最近一次 lookup 时间',
  `last_submit_at` DATETIME DEFAULT NULL COMMENT '最近一次创建任务时间',
  `last_sync_at` DATETIME DEFAULT NULL COMMENT '最近一次同步详情时间',
  `raw_lookup_json` LONGTEXT DEFAULT NULL COMMENT 'lookup 原始响应',
  `raw_run_json` LONGTEXT DEFAULT NULL COMMENT 'create/detail 原始响应',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_chain_contract` (`chain_id`, `contract_address`),
  KEY `idx_remote_run_id` (`remote_run_id`),
  KEY `idx_remote_status` (`remote_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='第三方审计任务映射表';
