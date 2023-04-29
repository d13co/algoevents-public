const { readFileSync } = require('fs');
const { encodeAddress } = require('algosdk');
const msgpack = require('algo-msgpack-with-bigint');
const { has } = require('lodash');
const { Loggable } = require('./loggable');

const logger = new Loggable('MATCHER');

class Matcher {
  publicRules = [];
  rules = [];

  constructor({ rulesFile, rules }) {
    if (rulesFile) {
      this.loadRulesFile(rulesFile);
    } else if (rules) {
      this.loadRules(rules);
    } else {
      throw new Error('No rules defined, pass rules: [] or rulesFile: string');
    }
  }

  loadRules(inputRules) {
    inputRules.forEach((rule, rule_i) => {
      for(const numericField of ['asaid', 'appid']) {
        if (rule[numericField] && typeof rule[numericField] !== "number") {
          try {
            const value = parseInt(rule[numericField], 10);
            if (isNaN(value)) {
              throw Error(`Expected numeric id in rule ${rule_i}, found ${rule[numericField]}`);
            }
            rule[numericField] = value;
          } catch(e) {
            logger.error(e.message, `in rule ${JSON.stringify(rule)}`);
            return;
          }
        }
      }
      this.publicRules.push({...rule});
      if (rule.note) {
        const noteRule = rule.note;
        rule.note = (note) => {
          if (noteRule.has && note) {
            return true;
          }
          if (noteRule.regex) {
            return note && noteRule.regex.test(note);
          }
          if (noteRule.encoding === 'msgpack') {
            try {
              note = msgpack.decode(note);
              if (!note || typeof note !== 'string')
                return false;
            } catch(e) {
              return false;
            }
          }
          if (noteRule.encoding === 'base64') {
            try {
              note = Buffer.from(Buffer.from(note), 'base64').toString('ascii');
              if (!note || typeof note !== 'string')
                return false;
            } catch(e) {
              return false;
            }
          }
          if (noteRule.includes) {
            return note.includes(noteRule.includes);
          }
          if (noteRule.startsWith) {
            return note.startsWith(noteRule.startsWith);
          }
          if (noteRule.endsWith) {
            return note.endsWith(noteRule.endsWith);
          }
          if (noteRule.exact) {
            return note === noteRule.exact;
          }
        }
      }
      this.rules.push(rule);
    });
    logger.debug('Loaded', this.rules.length, 'rules', this.publicRules);
  }

  loadRulesFile(filename) {
    const json = JSON.parse(readFileSync(filename).toString());
    this.loadRules(json);
  }

  checkTxs(txs) {
    // txIdx matched ruleIdx
    return txs.map((tx, txIdx) => {
      const matches = this.checkTx(tx);
      if (matches && matches.length) {
        return [txIdx, ...matches];
      }
    }).filter(Boolean);
  }

  checkTx(tx) {
    return this.rules
      .map((rule, idx) => {
        if (rule.inner && tx.dt?.itx) {
          return checkItx(rule, tx.dt.itx) ? idx : false;
        } else {
          if (ruleMatches(rule, tx)) {
            return idx;
          };
        }
      })
      .filter(arg => arg === 0 || !!arg);
  }

}


function checkItx(rule, itx) {
  return itx.some(itx1 => {
    return ruleMatches(rule, itx1) || (itx1.dt?.itx ? checkItx(rule, itx1.dt.itx) : false);
  });
}

function getItx(rule, itx) {
  return itx.reduce((matching, tx) => {
    if (tx.dt?.itx) {
      const inner = getItx(rule, tx.dt.itx);
      if (inner.length)
        matching.push(...inner);
    }
    if (ruleMatches(rule, tx))
      matching.push(tx);
    return matching;
  }, []);
}

function ruleMatches(rule, tx) {
  return Object.entries(rule).every(
    ([ruleKey, ruleValue]) => {
      let addr;
      switch(ruleKey) {
        case 'label':
        case 'chain':
          return true;
        case 'type':
          return tx.txn?.type === ruleValue;
        case 'rcv':
          addr = tx.txn?.rcv ?? tx.txn?.arcv;
          // fall through intentional
        case 'snd':
          addr = ruleKey === 'snd' ? tx.txn?.snd : addr;
          if (!addr) {
            return false;
          }
          addr = encodeAddress(addr);
          return Array.isArray(ruleValue) ? ruleValue.includes(addr) : addr == ruleValue;
        case 'asaid':
          return tx.txn?.xaid === ruleValue || (
            tx.txn.apas?.some(apa => apa === ruleValue)
          );
        case 'appid':
          return tx.txn?.apid === ruleValue;
        case "args":
          return tx.txn?.apaa?.some(a => Buffer.from(a).toString() === ruleValue);
        case "note":
          return tx.txn?.note && ruleValue(tx.txn.note);
        case "amt":
          return (tx.txn?.amt ?? tx.txn?.aamt ?? 0) == ruleValue;
        case "amtgte":
            return (tx.txn?.amt ?? tx.txn?.aamt) >= ruleValue;
        case "amtlte":
          return (tx.txn?.amt ?? tx.txn?.aamt ?? 0) <= ruleValue;
        case "has":
          return has(tx.txn, ruleValue);
        // non rules
        case "callback":
        case "inner":
          return true;
        default:
          logger.warn('Uncoded rule', ruleKey, ruleValue);
          return true;
      }
    }
  );
}

Matcher.getItx = getItx;

module.exports = Matcher;
