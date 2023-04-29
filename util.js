const { encodeAddress } = require('algosdk');
const { Transaction } = require('algosdk');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rejectAfter(ms, msg) {
  let timeout;
  const promise = new Promise((_, reject) => timeout = setTimeout(() => reject(new Error(msg)), ms));
  const cancel = () => clearTimeout(timeout);
  return { promise, cancel };
}

async function resolveAfter(ms, val) {
  return new Promise((resolve) => setTimeout(() => resolve(val), ms));
}

async function withTimeout(fn, timeout, msg) {
  const { promise: rejectPromise, cancel: rejectCancel, ...r } = rejectAfter(timeout, msg);
  const res = await Promise.race([
    fn(),
    rejectPromise,
  ]);
  rejectCancel();
  return res;
};

function getTxID(txn, { gen, gh }) {
  txn.gen = gen;
  txn.gh = gh;
  try {
    const tx = Transaction.from_obj_for_encoding(txn);
    return tx.txID();
  } catch(e) {
    console.error(e);
  }
}

async function getCurrentBlock(algodClient) {
  const status = await algodClient.status().do();
  const lastRound = status['last-round'];
  if (!lastRound) {
    throw new Error('Could not get last round');
  }
  return lastRound;
}

function JSONStringify(obj) {
  return JSON.stringify(obj, (key, value) => 
    typeof value === "bigint" ? `BIGINT::${value}` : value
  );
}

function JSONParse(obj) {
  return JSON.parse(obj, (key, value) => {
    if (typeof value === "string" && value.startsWith('BIGINT::')) {
      return BigInt(value.substr(8));
    }
    return value;
  });
}

function getTxInfo(txn, block, group) {
  const { id, snd, rcv, grp, note } = txn;
  return {
    id,
    grp: grp ? Buffer.from(grp).toString('base64') : undefined,
    grpNum: grp ? (group ? group.length : getGroupTxn(txn, block).length) : null,
    rnd: block.rnd,
    rndTs: block.ts,
    snd: encodeAddress(txn.snd),
    rcv: rcv ? encodeAddress(txn.rcv) : undefined,
    note: note ? Buffer.from(note).toString('base64') : null,
  }
}

function defined(...x) {
  return x.every(x => typeof x !== "undefined");
}

function objToString(obj) {
  if (typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  const s = [];
  if (Array.isArray(obj)) {
    for(const elem of obj) {
      for(const [key, value] of Object.entries(elem)) {
        s.push(`${key}:${value}`);
      }
    }
  } else {
    for(const [key, value] of Object.entries(obj)) {
      s.push(`${key}:${value}`);
    }
  }
  return s.join(',');
}

function getGroupTxn(targetTxn, block) {
  return !targetTxn.grp ? [] : block.txns.filter(({txn}) => txn?.grp?.equals(targetTxn.grp));
}

module.exports = {
  defined,
  sleep,
  rejectAfter,
  resolveAfter,
  withTimeout,
  getTxID,
  getCurrentBlock,
  JSONStringify,
  JSONParse,
  getTxInfo,
  objToString,
  getGroupTxn,
};
