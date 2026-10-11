class TokenBytecodeFilter {
  constructor(web3, chainConfig) {
    this.web3 = web3;
    this.chainConfig = chainConfig;
    this.config = chainConfig.scan?.bytecodeFilter || {};
    this.cache = new Map();
  }

  isEnabled() {
    return Boolean(this.web3 && this.config.enabled && this.rules().length > 0);
  }

  rules() {
    return (this.config.rules || [])
      .map(rule => ({
        addressSuffix: String(rule.addressSuffix || '').trim().toLowerCase().replace(/^0x/, ''),
        bytecode: this.normalizeBytecode(rule.bytecode),
        reason: String(rule.reason || 'bytecode_filter').trim() || 'bytecode_filter'
      }))
      .filter(rule => /^0x[a-f0-9]+$/.test(rule.bytecode));
  }

  async filterTokenAddresses(tokenAddresses, context = {}) {
    const uniqueTokens = Array.from(new Set(
      (tokenAddresses || [])
        .map(tokenAddress => String(tokenAddress || '').trim().toLowerCase())
        .filter(Boolean)
    ));
    if (!this.isEnabled() || uniqueTokens.length === 0) {
      return {
        allowed: uniqueTokens,
        skipped: []
      };
    }

    const allowed = [];
    const skipped = [];
    for (const tokenAddress of uniqueTokens) {
      const decision = await this.shouldSkip(tokenAddress);
      if (decision.skip) {
        skipped.push({
          tokenAddress,
          reason: decision.reason,
          addressSuffix: decision.addressSuffix,
          bytecodeLength: decision.bytecodeLength
        });
        console.log(
          `[${this.chainConfig.key}] token=${tokenAddress} bytecodeFilter 跳过 reason=${decision.reason} suffix=${decision.addressSuffix || 'n/a'} context=${this.formatContext(context)}`
        );
        continue;
      }

      allowed.push(tokenAddress);
    }

    return { allowed, skipped };
  }

  async shouldSkip(tokenAddress) {
    const normalizedToken = String(tokenAddress || '').trim().toLowerCase();
    if (!this.web3?.utils?.isAddress(normalizedToken)) {
      return { skip: false };
    }

    if (this.cache.has(normalizedToken)) {
      return this.cache.get(normalizedToken);
    }

    let code = '';
    try {
      code = this.normalizeBytecode(await this.withTimeout(
        this.web3.eth.getCode(normalizedToken),
        `getCode ${normalizedToken}`
      ));
    } catch (error) {
      const decision = { skip: false, error: error.message };
      this.cache.set(normalizedToken, decision);
      console.warn(`[${this.chainConfig.key}] token=${normalizedToken} bytecodeFilter getCode 失败，放行: ${error.message}`);
      return decision;
    }

    const decision = this.matchRule(normalizedToken, code) || { skip: false };
    this.cache.set(normalizedToken, decision);
    return decision;
  }

  matchRule(tokenAddress, code) {
    if (!code || code === '0x') {
      return null;
    }

    for (const rule of this.rules()) {
      if (rule.addressSuffix && !tokenAddress.endsWith(rule.addressSuffix)) {
        continue;
      }
      if (code !== rule.bytecode) {
        continue;
      }

      return {
        skip: true,
        reason: rule.reason,
        addressSuffix: rule.addressSuffix,
        bytecodeLength: Math.max(0, (code.length - 2) / 2)
      };
    }

    return null;
  }

  normalizeBytecode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return '';
    }
    return normalized.startsWith('0x') ? normalized : `0x${normalized}`;
  }

  formatContext(context) {
    return Object.entries(context || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(',') || 'n/a';
  }

  withTimeout(promise, label) {
    const timeoutMs = Math.max(1000, Number(this.config.rpcTimeoutMs || 10000));
    let timer = null;
    return Promise.race([
      promise.finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  }
}

module.exports = TokenBytecodeFilter;
