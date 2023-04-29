const levels = {
  error: 1,
  warn: 2,
  log: 3,
  info: 4,
  debug: 5,
}

const level = (process.env.LOG ?? process.env.log ?? 'debug').toLowerCase();

if (!levels[level]) {
  console.log(`Unknown log level: ${level}. Defaulting to debug`);
}

const level_i = levels[level];

function shouldLog(level) {
  if (!levels[level])
    console.log(`Unknown log level: ${level}.`);
  return level_i >= levels[level];
}

class Loggable {
  constructor(...prefixes) {
    this.prefixes = prefixes;
  }
  debug(...args) {
    if (level_i >= levels.debug)
      console.warn((new Date()).toISOString(), 'DEBUG', ...this.prefixes, ...args);
  }
  info(...args) {
    if (level_i >= levels.info)
      console.warn((new Date()).toISOString(), 'INFO', ...this.prefixes, ...args);
  }
  log(...args) {
    if (level_i >= levels.log)
      console.warn((new Date()).toISOString(), 'LOG', ...this.prefixes, ...args);
  }
  warn(...args) {
    if (level_i >= levels.warn)
      console.warn((new Date()).toISOString(), 'WARN', ...this.prefixes, ...args);
  }
  error(...args) {
    if (level_i >= levels.error)
      console.error((new Date()).toISOString(), 'ERROR', ...this.prefixes, ...args);
  }
}

module.exports = { Loggable, shouldLog };
