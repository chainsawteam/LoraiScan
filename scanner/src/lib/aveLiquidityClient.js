class AveLiquidityClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.AVE_BASE_URL || 'https://ave.invincible.best').replace(/\/+$/, '');
    this.apiKey = options.apiKey || process.env.AVE_API_KEY || '';
    this.timeoutMs = Number(options.timeoutMs || process.env.AVE_TIMEOUT_MS || 15000);
    this.retries = Number(options.retries || process.env.AVE_RETRIES || 2);
    this.authHeader = options.authHeader || process.env.AVE_AUTH_HEADER || 'authorization';
    this.rateLimiter = options.rateLimiter || null;
  }

  async health() {
    return this.request('/health', { auth: false });
  }

  async getLiquidity(params) {
    const search = new URLSearchParams();
    search.set('chainId', String(params.chainId));
    search.set('tokenAddress', params.tokenAddress);
    search.set('address', params.address || '');
    search.set('platform', params.platform || 'web');
    search.set('lang', params.lang || 'en');

    return this.request(`/liquidity?${search.toString()}`, { method: 'GET' });
  }

  async postLiquidity(params) {
    return this.request('/liquidity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        chainId: params.chainId,
        tokenAddress: params.tokenAddress,
        address: params.address || '',
        platform: params.platform || 'web',
        lang: params.lang || 'en'
      })
    });
  }

  async request(path, options = {}) {
    const method = options.method || 'GET';
    let lastError;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        if (this.rateLimiter) {
          await this.rateLimiter.wait();
        }

        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: this.buildHeaders(options.headers || {}, options.auth !== false),
          body: options.body,
          signal: controller.signal
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
          const error = new Error(payload?.error || `Ave request failed with HTTP ${response.status}`);
          error.statusCode = response.status;
          error.payload = payload;
          throw error;
        }

        return payload;
      } catch (error) {
        lastError = error;
        if (attempt >= this.retries || !this.shouldRetry(error)) {
          throw error;
        }
        await this.sleep(250 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError;
  }

  buildHeaders(headers, auth) {
    const result = { ...headers };
    if (!auth) {
      return result;
    }
    if (!this.apiKey) {
      throw new Error('缺少 AVE_API_KEY');
    }

    if (this.authHeader.toLowerCase() === 'x-api-key') {
      result['x-api-key'] = this.apiKey;
    } else {
      result.authorization = `Bearer ${this.apiKey}`;
    }

    return result;
  }

  shouldRetry(error) {
    if (error.name === 'AbortError') {
      return true;
    }
    if (!error.statusCode) {
      return true;
    }

    return error.statusCode >= 500;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AveLiquidityClient;
