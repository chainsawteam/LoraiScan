const { isCakeLpToken } = require('../lib/tokenFilters');
const LoraiAuditClient = require('../lib/loraiAuditClient');
const FactoryLiquidityResolver = require('../lib/factoryLiquidityResolver');
const { PoolLiquidityCalibrator } = require('../lib/poolLiquidityCalibrator');
const TokenBytecodeFilter = require('../lib/tokenBytecodeFilter');

class AveLiquidityTokenSource {
  constructor(client, repository, chainConfig, web3 = null) {
    this.client = client;
    this.repository = repository;
    this.chainConfig = chainConfig;
    this.auditClient = new LoraiAuditClient(chainConfig.scan?.audit || {}, chainConfig);
    this.calibrator = new PoolLiquidityCalibrator(web3, chainConfig);
    this.factoryResolver = new FactoryLiquidityResolver(web3, chainConfig, this.calibrator.quoteTokens);
    this.bytecodeFilter = new TokenBytecodeFilter(web3, chainConfig);
  }

  async bootstrap() {
    if (this.chainConfig.scan.autoMigrate) {
      await this.repository.migrateAveSchema();
    }

    const seedTokens = this.chainConfig.scan.seedTokens || [];
    if (seedTokens.length > 0) {
      await this.repository.seedScanTokens(this.chainConfig, seedTokens, 'env');
      console.log(`[${this.chainConfig.key}] 已从环境变量导入 ${seedTokens.length} 个待扫 token`);
    }
  }

  async scanTarget(target, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const limit = target.batchSize || this.chainConfig.scan.updateLimit || 100;
    let totalScanned = 0;

    while (true) {
      const tokens = await this.repository.getDueScanTokens(this.chainConfig, limit);

      if (tokens.length === 0) {
        if (totalScanned === 0) {
          console.log(`[${this.chainConfig.key}] target=${target.name} 没有到期待扫 token`);
        } else {
          console.log(`[${this.chainConfig.key}] target=${target.name} 到期待扫 token 已处理完 total=${totalScanned}`);
        }
        return;
      }

      console.log(`[${this.chainConfig.key}] target=${target.name} 本轮准备查询 ${tokens.length} 个 token`);

      for (const row of tokens) {
        await this.scanToken(target, row.token_address, dryRun);
        totalScanned += 1;
      }

      if (!target.drainUntilEmpty || dryRun || tokens.length < limit) {
        return;
      }
    }
  }

  async refreshTarget(target, tokenAddresses) {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
      return;
    }

    for (const tokenAddress of tokenAddresses) {
      await this.scanToken(target, tokenAddress, false);
    }
  }

  async scanToken(target, tokenAddress, dryRun, options = {}) {
    try {
      const filterResult = await this.bytecodeFilter.filterTokenAddresses([tokenAddress], {
        source: 'scan-token',
        target: target.name || 'n/a'
      });
      if (filterResult.allowed.length === 0) {
        const reason = filterResult.skipped[0]?.reason || 'bytecode_filter';
        if (!dryRun) {
          await this.repository.markScanTokenIgnored(this.chainConfig, tokenAddress, reason);
        }
        console.log(`[${this.chainConfig.key}] token=${tokenAddress} 扫描前跳过 reason=${reason}`);
        return;
      }

      const result = await this.scanTokenLiquidity(target, tokenAddress, { dryRun, ...options });
      if (!result || dryRun) {
        return;
      }

      await this.maybeTriggerAudit(tokenAddress, result.pairs, result.calibration, result.token, result.liquidityUsd);
    } catch (error) {
      console.error(`[${this.chainConfig.key}] token=${tokenAddress} Ave 查询失败: ${error.message}`);
      if (!dryRun) {
        if (this.isPermanentSkipError(error)) {
          const reason = `permanent_scan_error:${error.message || error}`;
          await this.repository.markScanTokenIgnored(this.chainConfig, tokenAddress, reason);
          console.warn(`[${this.chainConfig.key}] token=${tokenAddress} 已跳过 reason=${reason.slice(0, 2000)}`);
          return;
        }

        await this.repository.markAveLiquidityFailure(
          this.chainConfig,
          tokenAddress,
          error,
          target.retryDelayMs || this.chainConfig.scan.retryDelayMs || 5 * 60 * 1000
        );
      }
    }
  }

  async scanTokenLiquidity(target, tokenAddress, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const factoryResult = await this.scanTokenLiquidityFromFactories(tokenAddress, { dryRun });
    if (factoryResult?.usable) {
      return factoryResult.result;
    }

    if (factoryResult?.attempted) {
      const reason = factoryResult.reason || 'no_factory_liquidity';
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} factory 主路径未命中 reason=${reason}，fallback AVE`);
    }

    const response = await this.client.getLiquidity({
      chainId: this.chainConfig.chainId,
      tokenAddress,
      address: target.address || '',
      platform: target.platform || 'web',
      lang: target.lang || 'en'
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Ave 返回 ok=false');
    }

    const token = response?.data?.token || {};
    if (isCakeLpToken(token)) {
      if (dryRun) {
        console.log(`[${this.chainConfig.key}] [dry-run] token=${tokenAddress} 命中 CAKE LP 过滤 symbol=${token.symbol || ''} name=${token.name || ''}`);
        return null;
      }

      await this.repository.markScanTokenIgnored(this.chainConfig, tokenAddress, 'filtered_cake_lp');
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} 已过滤 CAKE LP symbol=${token.symbol || ''} name=${token.name || ''}`);
      return null;
    }

    const originalPairs = Array.isArray(response?.data?.pairs) ? response.data.pairs : [];
    const filteredPairs = this.filterPairsByAmm(originalPairs, target.ammAllowlist || []);
    const calibration = await this.calibrator.calibratePairs(filteredPairs);
    const calibratedPairs = calibration.calibratedPairs || filteredPairs;
    const filteredResponse = {
      ...response,
      data: {
        ...(response.data || {}),
        token: this.withCalibratedMainPairTvl(response?.data?.token || {}, calibratedPairs),
        pairs: calibratedPairs,
        liquidity_calibration: {
          enabled: calibration.enabled,
          calibratedPairs: calibration.calibrations.length,
          calibratedLiquidityUsd: calibration.calibratedLiquidityUsd,
          errors: calibration.errors
        }
      }
    };
    const pairsCount = calibratedPairs.length;
    const mainPairTvl = response?.data?.token?.main_pair_tvl;
    const liquidityUsd = this.resolveLiquidityUsd(calibratedPairs, calibration, filteredResponse.data.token);
    const calibrationSummary = calibration.enabled
      ? ` calibratedPairs=${calibration.calibrations.length} calibratedLiquidityUsd=${this.formatUsd(calibration.calibratedLiquidityUsd)}`
      : '';

    if (dryRun) {
      console.log(`[${this.chainConfig.key}] [dry-run] token=${tokenAddress} pairs=${pairsCount}/${originalPairs.length} mainPairTvl=${mainPairTvl ?? 'null'} liquidityUsd=${this.formatUsd(liquidityUsd)}${calibrationSummary}`);
      if (calibration.errors.length > 0) {
        console.log(`[${this.chainConfig.key}] [dry-run] token=${tokenAddress} calibrationErrors=${calibration.errors.join(';')}`);
      }
      if (options.printResponse) {
        console.log(`[${this.chainConfig.key}] [dry-run] AVE context=${JSON.stringify(options.context || {})}`);
        console.log(`[${this.chainConfig.key}] [dry-run] AVE response token=${tokenAddress} ${JSON.stringify(filteredResponse)}`);
      }
      return {
        pairs: calibratedPairs,
        calibration,
        token: filteredResponse.data.token,
        liquidityUsd
      };
    }

    await this.saveAveLiquidityResultWithRetry(tokenAddress, filteredResponse, { liquidityUsd });
    console.log(`[${this.chainConfig.key}] token=${tokenAddress} 流动性已更新 pairs=${pairsCount}/${originalPairs.length} mainPairTvl=${mainPairTvl ?? 'null'} liquidityUsd=${this.formatUsd(liquidityUsd)}${calibrationSummary}`);
    if (calibration.errors.length > 0) {
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} calibrationErrors=${calibration.errors.join(';')}`);
    }

    return {
      pairs: calibratedPairs,
      calibration,
      token: filteredResponse.data.token,
      liquidityUsd
    };
  }

  async scanTokenLiquidityFromFactories(tokenAddress, options = {}) {
    if (!this.factoryResolver.isEnabled()) {
      return { attempted: false, usable: false, reason: 'factory_lookup_disabled' };
    }

    const dryRun = Boolean(options.dryRun);
    const resolved = await this.factoryResolver.resolvePairs(tokenAddress);
    if (!resolved.enabled) {
      return { attempted: false, usable: false, reason: 'factory_lookup_disabled' };
    }

    if (resolved.errors.length > 0) {
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} factoryLookupErrors=${resolved.errors.join(';')}`);
    }

    if (resolved.pairs.length === 0) {
      return { attempted: true, usable: false, reason: 'no_pool_found' };
    }

    const calibration = await this.calibrator.calibratePairs(resolved.pairs);
    const calibratedPairs = calibration.calibratedPairs || resolved.pairs;
    const hasCalibratedPool = Array.isArray(calibration.calibrations) && calibration.calibrations.length > 0;
    if (!hasCalibratedPool) {
      return {
        attempted: true,
        usable: false,
        reason: calibration.errors.length > 0 ? 'balanceof_failed' : 'no_quote_pool_calibrated'
      };
    }

    const mainPair = this.resolveMainPair(calibratedPairs);
    const liquidityUsd = this.resolveLiquidityUsd(calibratedPairs, calibration, {
      main_pair_tvl: mainPair?.pair_tvl_usd
    });
    const syntheticResponse = {
      ok: true,
      source: 'factory_balanceof',
      data: {
        token: {
          chain: this.chainConfig.key,
          main_pair: mainPair?.pair || null,
          main_pair_tvl: mainPair?.pair_tvl_usd || 0,
          liquidity_source: 'factory_balanceof'
        },
        pairs: calibratedPairs,
        liquidity_calibration: {
          enabled: calibration.enabled,
          source: 'factory_balanceof',
          factoryPairs: resolved.pairs.length,
          calibratedPairs: calibration.calibrations.length,
          calibratedLiquidityUsd: calibration.calibratedLiquidityUsd,
          errors: calibration.errors
        }
      }
    };

    const summary = `factoryPairs=${resolved.pairs.length} calibratedPairs=${calibration.calibrations.length} liquidityUsd=${this.formatUsd(liquidityUsd)}`;
    if (dryRun) {
      console.log(`[${this.chainConfig.key}] [dry-run] token=${tokenAddress} factory 主路径命中 ${summary}`);
      if (calibration.errors.length > 0) {
        console.log(`[${this.chainConfig.key}] [dry-run] token=${tokenAddress} calibrationErrors=${calibration.errors.join(';')}`);
      }
      return {
        attempted: true,
        usable: true,
        result: {
          pairs: calibratedPairs,
          calibration,
          token: syntheticResponse.data.token,
          liquidityUsd
        }
      };
    }

    await this.saveAveLiquidityResultWithRetry(tokenAddress, syntheticResponse, { liquidityUsd });
    console.log(`[${this.chainConfig.key}] token=${tokenAddress} factory 主路径流动性已更新 ${summary}`);
    if (calibration.errors.length > 0) {
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} calibrationErrors=${calibration.errors.join(';')}`);
    }

    return {
      attempted: true,
      usable: true,
      result: {
        pairs: calibratedPairs,
        calibration,
        token: syntheticResponse.data.token,
        liquidityUsd
      }
    };
  }

  async maybeTriggerAudit(tokenAddress, pairs, calibration = null, token = null, liquidityUsdOverride = null) {
    const auditConfig = this.chainConfig.scan?.audit || {};
    if (!auditConfig.enabled) {
      return;
    }

    const thresholdUsd = Number(auditConfig.minLiquidityUsd || 10000);
    const hasOverride = liquidityUsdOverride !== undefined && liquidityUsdOverride !== null && liquidityUsdOverride !== '';
    const override = hasOverride ? Number(liquidityUsdOverride) : NaN;
    const liquidityUsd = hasOverride && Number.isFinite(override)
      ? override
      : this.resolveLiquidityUsd(pairs, calibration, token);

    if (!Number.isFinite(liquidityUsd) || liquidityUsd <= thresholdUsd) {
      console.log(`[${this.chainConfig.key}] token=${tokenAddress} LORAI 跳过 liquidityUsd=${this.formatUsd(liquidityUsd)} threshold=${thresholdUsd}`);
      return;
    }

    try {
      const result = await this.auditClient.ensureAudit(this.chainConfig, tokenAddress, {
        priority: auditConfig.priority
      });
      if (result.skipped) {
        console.log(`[${this.chainConfig.key}] token=${tokenAddress} LORAI 跳过 reason=${result.reason} liquidityUsd=${this.formatUsd(liquidityUsd)}`);
        if (result.reason === 'existing_audit') {
          await this.repository.markScanTokenAuditComplete(this.chainConfig, tokenAddress, 'audit_exists');
        }
        return;
      }

      console.log(`[${this.chainConfig.key}] token=${tokenAddress} LORAI 已触发 run_id=${result.runId || 'n/a'} liquidityUsd=${this.formatUsd(liquidityUsd)}`);
      await this.repository.markScanTokenAuditComplete(this.chainConfig, tokenAddress, 'audit_submitted');
    } catch (error) {
      console.error(`[${this.chainConfig.key}] token=${tokenAddress} LORAI 触发失败 liquidityUsd=${this.formatUsd(liquidityUsd)} err=${error.message}`);
    }
  }

  resolveLiquidityUsd(pairs, calibration = null, token = null) {
    const pairLiquidityUsd = this.computeTotalLiquidityUsd(pairs);
    const mainPairTvl = Number(token?.main_pair_tvl);

    if (this.calibrator.isEnabled() && Array.isArray(calibration?.calibrations) && calibration.calibrations.length > 0) {
      return pairLiquidityUsd;
    }

    if (Number.isFinite(mainPairTvl) && mainPairTvl > pairLiquidityUsd) {
      return mainPairTvl;
    }

    return pairLiquidityUsd;
  }

  computeTotalLiquidityUsd(pairs) {
    return (pairs || []).reduce((total, pair) => {
      const pairTvl = Number(pair.pair_tvl_usd);
      if (Number.isFinite(pairTvl) && pairTvl > 0) {
        return total + pairTvl;
      }

      const reserve0 = Number(pair.reserve0);
      const reserve1 = Number(pair.reserve1);
      const price0 = Number(pair.token0_price_usd);
      const price1 = Number(pair.token1_price_usd);
      const computed = reserve0 * price0 + reserve1 * price1;
      return Number.isFinite(computed) && computed > 0 ? total + computed : total;
    }, 0);
  }

  resolveMainPair(pairs) {
    return (pairs || [])
      .map(pair => ({
        pair,
        tvl: Number(pair?.pair_tvl_usd)
      }))
      .filter(item => item.pair?.pair && Number.isFinite(item.tvl))
      .sort((a, b) => b.tvl - a.tvl)[0]?.pair || null;
  }

  filterPairsByAmm(pairs, allowlist) {
    if (!allowlist.length) {
      return pairs;
    }

    return pairs.filter(pair => {
      const amm = String(pair.amm || '').toLowerCase();
      return allowlist.some(allowed => amm.includes(allowed));
    });
  }

  withCalibratedMainPairTvl(token, pairs) {
    const mainPair = String(token.main_pair || '').toLowerCase();
    if (!mainPair) {
      return token;
    }

    const calibratedMainPair = (pairs || []).find(pair => (
      String(pair?.pair || '').toLowerCase() === mainPair
      && pair?.liquidity_calibrated
    ));
    if (!calibratedMainPair) {
      return token;
    }

    return {
      ...token,
      main_pair_tvl: calibratedMainPair.pair_tvl_usd,
      ave_main_pair_tvl: token.main_pair_tvl
    };
  }

  formatUsd(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(6) : 'n/a';
  }

  async saveAveLiquidityResultWithRetry(tokenAddress, response, options = {}) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.repository.saveAveLiquidityResult(this.chainConfig, tokenAddress, response, options);
        return;
      } catch (error) {
        if (attempt >= maxAttempts || !this.isTransientDbError(error)) {
          throw error;
        }

        await this.sleep(100 * attempt);
      }
    }
  }

  isTransientDbError(error) {
    return error?.code === 'ER_LOCK_DEADLOCK'
      || error?.code === 'ER_LOCK_WAIT_TIMEOUT'
      || error?.errno === 1213
      || error?.errno === 1205;
  }

  isPermanentSkipError(error) {
    const message = String(error?.message || error || '');
    return error?.code === 'ER_WARN_DATA_OUT_OF_RANGE'
      || error?.errno === 1264
      || /Out of range value for column/i.test(message);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AveLiquidityTokenSource;
