export const SUBSCRIPTION_ENV_KEY = 'AZURE_SUBSCRIPTION_ID';

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBSCRIPTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_PREFIX = /^\ufeff?\s*(?:export\s+)?AZURE_SUBSCRIPTION_ID\s*=/;
const TARGET_ASSIGNMENT =
  /^(\ufeff?\s*(?:export\s+)?AZURE_SUBSCRIPTION_ID\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^"'#]*?))(\s*(?:#.*)?)$/;

export function validateAzdEnvironmentName(value) {
  const name = String(value || '').trim();
  if (!ENVIRONMENT_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('The Main environment name is not a safe azd environment folder name.');
  }
  return name;
}

export function validateSubscriptionId(value) {
  const id = String(value || '').trim();
  if (!SUBSCRIPTION_ID.test(id)) {
    throw new Error('Subscription ID must be a complete Azure subscription GUID.');
  }
  return id;
}

function targetEntries(text) {
  const entries = [];
  const lines = String(text).match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
  let offset = 0;
  for (const rawLine of lines) {
    if (!rawLine) continue;
    const eol = rawLine.endsWith('\r\n') ? '\r\n' : rawLine.endsWith('\n') ? '\n' : '';
    const line = eol ? rawLine.slice(0, -eol.length) : rawLine;
    if (!TARGET_PREFIX.test(line)) {
      offset += rawLine.length;
      continue;
    }
    const match = TARGET_ASSIGNMENT.exec(line);
    if (!match) {
      throw new Error(`${SUBSCRIPTION_ENV_KEY} has unsupported .env syntax.`);
    }
    const group = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
    const value = match[group].trim();
    const relative = match[1].length + (group === 2 || group === 3 ? 1 : 0);
    entries.push({
      value,
      span: { start: offset + relative, end: offset + relative + match[group].length },
    });
    offset += rawLine.length;
  }
  if (entries.length > 1) {
    throw new Error(`${SUBSCRIPTION_ENV_KEY} is declared more than once.`);
  }
  return entries;
}

export function readSubscriptionIdFromText(text) {
  const entry = targetEntries(text)[0] || null;
  return {
    found: Boolean(entry),
    value: entry?.value || '',
    valid: Boolean(entry && SUBSCRIPTION_ID.test(entry.value)),
  };
}

export function writeSubscriptionIdToText(text, value) {
  const id = validateSubscriptionId(value);
  const source = String(text);
  const entry = targetEntries(source)[0] || null;
  if (entry) {
    return source.slice(0, entry.span.start) + id + source.slice(entry.span.end);
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const separator = source && !/[\r\n]$/.test(source) ? eol : '';
  return `${source}${separator}${SUBSCRIPTION_ENV_KEY}="${id}"${eol}`;
}
