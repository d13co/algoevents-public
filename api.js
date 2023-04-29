const lodash = require('lodash');
const ExpoBackoff = require('./expo-backoff');
const { getTxID, getCurrentBlock, withTimeout, rejectAfter, resolveAfter } = require('./util');
const Matcher = require('./matcher');
const expoBackoff = new ExpoBackoff();
const { Loggable } = require('./loggable');

class AlgoEvents {
  rules;
  algod;
  since;
  direction;
  onRound;

  _running;

  constructor({ rules, getRules, algod, logger, onRound, threads }) {
    this.rules = rules;
    this.getRules = getRules;
    this.algod = algod;
    this.logger = new Loggable('API');
    this.onRound = onRound;
    this.threads = threads;

    if (!this.rules?.length) {
      if (typeof this.getRules !== 'function') {
        throw new Error('No matcher rules');
      }
    }

    if (!this.algod) {
      throw new Error('No algod client');
    }

    if (rules)
      this.matcher = new Matcher({ rules });
    }

  async prepare() {
    if (!this.since) {
      this.since = await getCurrentBlock(this.algod);
    }
    if (this.getRules) {
      this.rules = await this.getRules()
      this.matcher = new Matcher({ rules: this.rules });
    }
  }

  async getBlock(round) {
    const expoBackoff = new ExpoBackoff();
    while(this._running) {
      try {
        this.logger.debug('Fetching', round);
        const { block, ...rest } = await withTimeout(
          () => this.algod.block(round).do(),
          20_000,
          'Timeout getting block'
        );
        // console.log('data', block, rest);
        if (!block) {
          throw new Error('No block in data');
        }
        return block;
      } catch(e) {
        const responseBody = e.response?.body ? JSON.stringify(e.response.body) : '';
        const notYet = /ledger does not have entry|failed to retrieve information from the ledger/i;
        if (notYet.test(e.message) || notYet.test(responseBody)) {
          this.logger.log(`Block ${round} not ready yet. Waiting for it`);
          await this.algod.statusAfterBlock(round-1).do();
        } else {
          this.logger.log(responseBody ?? e.message);
          throw e;
        }
      }
    }
  }

  async processBlock(round) {
    this.lastRound = round;
    const block = await this.getBlock(round);
    this.logger.debug(`processing ${round}`);
    if (this.onRound) {
      try {
        this.onRound(round);
      } catch(e) {
        this.logger.warn(`OnRound error for round ${round}:`);
        this.logger.warn(e.message);
      }
    }
    if (!block?.txns) {
      this.logger.debug(`Warning block ${round} had no transactions`);
      return true;
    }
    const { gen, gh } = block;
    const matched = this.matcher.checkTxs(block.txns);
    this.actions?.roundProcessed(block.rnd, block.txns?.length ?? 0, matched.length ?? 0);
    if (matched.length) {
      const actionObjects = [];
      for(const match of matched) {
        const [txIdx, ruleIdx] = match;
        const outer  = block.txns[txIdx];
        const { txn } = outer
        const note = txn.note? Buffer.from(txn.note).toString() : '';
        txn.id = getTxID(txn, block);
        this.logger.log(`Tx id ${txn.id} round ${block.rnd} matched rule ${ruleIdx}`);
        let ret;
        try {
          ret = this.rules[ruleIdx].callback(txn, block, outer);
          if (ret?.then)
            ret = await ret;
        } catch(e) {
          this.logger.error(`Error processing ${txn.id}: ${e}`);
        }
        if (ret) {
          if (Array.isArray(ret)) {
            actionObjects.push(...ret);
          } else {
            actionObjects.push(ret);
          }
        } else {
          // this.logger.error(`Error: No return object for rule ${ruleIdx} for tx ${txn.id} round ${block.rnd}`);
        }
      }
      this.actions?.ingest(actionObjects);
    }
  }

  async run(since, until) {
    if (since)
      this.since = since;
    if (until)
      this.until = until;
    await this.prepare();
    this._running = true;
    this.logger.log('Starting at', this.since);
    this.currentRound = this.since;
    while(this._running) {
      try {
        this.logger.debug("processing", this.currentRound);
        await this.processBlock(this.currentRound);
        this.logger.debug("processed", this.currentRound);
        this.currentRound += this.backwards ? -1 : 1;
        if (this.until) {
          if (this.backwards && this.currentRound < this.until) {
            await this.gracefulStop();
          } else if (!this.backwards && this.currentRound > this.until) {
            await this.gracefulStop();
          }
        }
        if (this.backwards && this.currentRound < 0)
          await this.gracefulStop();
        expoBackoff.reset();
      } catch(e) {
        this.logger.error(e);
        if (!(await expoBackoff.backoff())) {
          this.logger.log('Exhausted retries: ', expoBackoff.maxFailures);
          throw new Error(e);
        }
      }
    }
  }

  getNextRound() {
    if (!this.specific) {
      throw new Error('not implemented');
    }
    if (this.currentIndex >= this.specific.length)
      return;
    return this.specific[this.currentIndex++];
  }

  async runThread(t) {
    this.logger.debug(`Thread ${t} starting`);
    while(true) {
      const round = this.getNextRound();
      if (round === undefined) {
        this.logger.debug(`Thread ${t} stopping`);
        return;
      }
      const expoBackoff = new ExpoBackoff();
      inner: while(true) {
        try {
          await this.processBlock(round);
          this.logger.log(t, "processed", round);
          break inner;
        } catch(e) {
          try {
            this.logger.error(e);
            if (!(await expoBackoff.backoff())) {
              this.logger.log(t, 'Exhausted retries: ', expoBackoff.maxFailures, 'for round', round);
              break inner;
            }
          } catch(e) {
            console.error(e);
          }
        }
      }
    }
  }

  async runRounds(rounds) {
    this._running = true;
    this.specific = rounds;
    this.logger.debug('Running for specific rounds', rounds.length);
    this.currentIndex = 0;
    await this.prepare();
    const threads = this.threads ?? 1;
    const threadPromises = [];
    for(let i=0; i<threads; i++) {
      threadPromises.push(this.runThread(i+1));
    }
    await Promise.all(threadPromises);
    this.logger.info('All threads finished');
    await this.gracefulStop();
  }

  async gracefulStop() {
    this._running = false;
    if (!this.actions)
      return;
    try {
      this.logger.info('Saving action backlog');
      this.actions.save();
      this.logger.info('Waiting for actions to complete');
      await this.actions.isDone();
      this.logger.debug('actions done');
      this.logger.info('Saving updated backlog');
      this.actions.save();
      this.logger.log('Stopped at', this.lastRound);
    } catch(e) {
      this.logger.error('Error during graceful stop', e);
    }
  }

  forceStop() {
    this.logger.log('Stopped at', this.lastRound);
    this._running = false;
    if (!this.actions)
      return;
    try {
      this.actions.save();
    } catch(e) {
      this.logger.error('Error saving actions', e);
    }
  }
}

module.exports = AlgoEvents;
