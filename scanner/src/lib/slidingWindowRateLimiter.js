class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.perSecond = Math.max(1, Number.parseInt(options.perSecond, 10) || 50);
    this.perMinute = Math.max(this.perSecond, Number.parseInt(options.perMinute, 10) || this.perSecond * 60);
    this.timestamps = [];
    this.queue = Promise.resolve();
  }

  async wait() {
    let release;
    const previous = this.queue;
    this.queue = new Promise(resolve => {
      release = resolve;
    });

    await previous;
    try {
      await this.reserveSlot();
    } finally {
      release();
    }
  }

  async reserveSlot() {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(timestamp => now - timestamp < 60000);
      const secondWindow = this.timestamps.filter(timestamp => now - timestamp < 1000);
      const waits = [];

      if (secondWindow.length >= this.perSecond) {
        waits.push(secondWindow[0] + 1000 - now);
      }

      if (this.timestamps.length >= this.perMinute) {
        waits.push(this.timestamps[0] + 60000 - now);
      }

      if (waits.length === 0) {
        this.timestamps.push(now);
        return;
      }

      await this.sleep(Math.max(1, Math.min(...waits)));
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SlidingWindowRateLimiter;
