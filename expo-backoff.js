const { sleep } = require('./util');

class ExpoBackoff {
  multiplier;
  maxWait;
  maxFailures;
  failures = 0;

  constructor({ maxWait, maxFailures, multiplier } = {}) {
    this.maxWait = maxWait ?? 60_000;
    this.maxFailures = maxFailures ?? 10;
    this.multiplier = multiplier ?? 1000;
  }

  reset() {
    this.failures = 0;
  }

  async backoff() {
    this.failures++;
    if (this.failures > this.maxFailures) {
      return false;
    }
    const sleepFor = Math.min(
      Math.pow(this.failures, 2) * this.multiplier,
      this.maxWait,
    );
    await sleep(sleepFor);
    return true;
  }
}

module.exports = ExpoBackoff;
