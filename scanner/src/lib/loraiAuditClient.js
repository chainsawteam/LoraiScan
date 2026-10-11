class LoraiAuditClient {
  constructor(options = {}, chainConfig = {}) {
    this.enabled = Boolean(options.enabled);
    this.baseUrl = String(options.baseUrl || process.env.LORAI_AUDIT_BASE_URL || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.LORAI_AUDIT_API_KEY || '';
    this.rpcUrl = options.rpcUrl || chainConfig?.rpc?.ws || chainConfig?.rpc?.http || '';
    this.validationMode = options.validationMode || process.env.LORAI_AUDIT_VALIDATION_MODE || 'onchain_trace';
    this.codexMode = options.codexMode || process.env.LORAI_AUDIT_CODEX_MODE || 'real';
    this.priority = Number(options.priority || process.env.LORAI_AUDIT_PRIORITY || 100);
    this.maxRetries = Number(options.maxRetries || process.env.LORAI_AUDIT_MAX_RETRIES || 2);
    this.timeoutMs = Number(options.timeoutMs || process.env.LORAI_AUDIT_TIMEOUT_MS || 15000);
  }

  isReady() {
    return this.enabled && Boolean(this.baseUrl) && Boolean(this.apiKey);
  }

  async ensureAudit(chainConfig, targetAddress, context = {}) {
    if (!this.enabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!this.baseUrl || !this.apiKey) {
      return { skipped: true, reason: 'missing_config' };
    }
    if (!this.rpcUrl) {
      return { skipped: true, reason: 'missing_rpc_url' };
    }

    const address = this.normalizeAddress(targetAddress);
    const lookup = context.skipLookup ? null : await this.lookup(chainConfig.chainId, address);
    if (!context.skipLookup && (lookup?.has_matching_runs || lookup?.hasMatchingRuns)) {
      return { skipped: true, reason: 'existing_audit' };
    }

    const created = await this.create(chainConfig, address, context);
    return {
      skipped: false,
      runId: created?.audit?.run_id || created?.audit?.job_id || ''
    };
  }

  async lookup(chainId, targetAddress) {
    const search = new URLSearchParams();
    search.set('chain_id', String(chainId));
    search.set('target_address', this.normalizeAddress(targetAddress));

    return this.request(`/api/audits/lookup?${search.toString()}`, { method: 'GET' });
  }

  async deleteAudit(chainId, targetAddress) {
    const search = new URLSearchParams();
    search.set('chain_id', String(chainId));
    search.set('target_address', this.normalizeAddress(targetAddress));

    return this.request(`/api/audits?${search.toString()}`, { method: 'DELETE' });
  }

  async recreateAudit(chainConfig, targetAddress, context = {}) {
    if (!this.enabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!this.baseUrl || !this.apiKey) {
      return { skipped: true, reason: 'missing_config' };
    }
    if (!this.rpcUrl) {
      return { skipped: true, reason: 'missing_rpc_url' };
    }

    const address = this.normalizeAddress(targetAddress);
    const lookup = await this.lookup(chainConfig.chainId, address);
    if (lookup?.has_matching_runs || lookup?.hasMatchingRuns) {
      await this.deleteAudit(chainConfig.chainId, address);
    }

    const created = await this.create(chainConfig, address, context);
    return {
      skipped: false,
      runId: created?.audit?.run_id || created?.audit?.job_id || ''
    };
  }

  async create(chainConfig, targetAddress, context = {}) {
    const address = this.normalizeAddress(targetAddress);
    return this.request('/api/audits', {
      method: 'POST',
      body: JSON.stringify({
        case_label: `${chainConfig.key}-${chainConfig.chainId}-${address.replace(/^0x/, '')}`,
        chain_id: chainConfig.chainId,
        rpc_url: this.rpcUrl,
        target_address: address,
        input_type: 'contract_address',
        validation_mode_override: this.validationMode,
        codex_mode: this.codexMode,
        priority: Number.isFinite(context.priority) ? context.priority : this.priority,
        max_retries: this.maxRetries
      })
    });
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...(options.body ? { 'content-type': 'application/json' } : {})
        },
        body: options.body,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        const error = new Error(payload?.error || `LORAI request failed with HTTP ${response.status}`);
        error.statusCode = response.status;
        error.payload = payload;
        throw error;
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  normalizeAddress(address) {
    const value = String(address || '').trim();
    if (value.startsWith('0x') || value.startsWith('0X')) {
      return `0x${value.slice(2).toLowerCase()}`;
    }
    return value.toLowerCase();
  }
}

module.exports = LoraiAuditClient;
