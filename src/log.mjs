// Small structured logger. Text for humans, `LOG_FORMAT=json` for log shippers.
// Nothing here ever prints a credential: signatures, tokens and secrets are redacted
// by key name before formatting, so a careless caller cannot leak one.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOURS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const REDACTED = new Set(['signature', 'token', 'secret', 'clientsecret', 'apikey', 'clientapikey', 'webhooksecret', 'cookie', 'authorization', 'csrf']);
const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const asJson = String(process.env.LOG_FORMAT || '').toLowerCase() === 'json';
const colour = Boolean(process.stdout.isTTY) && !asJson;

const redact = (key, value) => (REDACTED.has(String(key).toLowerCase().replace(/[^a-z]/g, '')) ? '[redacted]' : value);

function pairs(fields) {
  const out = [];
  for (const [key, raw] of Object.entries(fields ?? {})) {
    if (raw === undefined) continue;
    const value = redact(key, raw);
    out.push([key, value instanceof Error ? value.message : value]);
  }
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const entries = pairs(fields);
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (asJson) {
    stream.write(JSON.stringify({ time: new Date().toISOString(), level, event, ...Object.fromEntries(entries) }) + '\n');
    return;
  }
  const stamp = new Date().toISOString().slice(11, 23);
  const tail = entries.map(([key, value]) => `${colour ? DIM : ''}${key}=${colour ? RESET : ''}${typeof value === 'string' && value.includes(' ') ? JSON.stringify(value) : value}`).join(' ');
  const tag = level.toUpperCase().padEnd(5);
  stream.write(`${colour ? DIM : ''}${stamp}${colour ? RESET : ''} ${colour ? COLOURS[level] : ''}${tag}${colour ? RESET : ''} ${event}${tail ? ' ' + tail : ''}\n`);
}

export const log = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
  level: Object.keys(LEVELS).find(name => LEVELS[name] === threshold) ?? 'info',
};
