/**
 * Access contracts.
 *
 * An access contract is a *folder*, not a file. Each contract folder holds a
 * pair of editable artefacts:
 *
 *   <contract>/main.bicepparam        parameters for the contract deployment
 *   <contract>/ai-product-policy.xml  the APIM product policy it loads
 *
 * Catalogue
 * ---------
 * Contracts are discovered by walking the citadel-access-contracts module and
 * treating every folder that contains a .bicepparam as a contract. Three
 * folders are plumbing rather than contracts and are excluded outright:
 *
 *   modules/         Bicep modules used by the template
 *   policies/        the shipped default policies (the creation source)
 *   base-contracts/  excluded by explicit instruction
 *
 * Template
 * --------
 * New contracts are always created from the module's own pair:
 *
 *   citadel-access-contracts/main.bicepparam
 *   citadel-access-contracts/policies/default-ai-product-policy.xml
 *
 * The template is fixed. There is deliberately no "create from another
 * contract" path: a single source keeps every new contract starting from the
 * documented baseline instead of inheriting whatever drift an existing
 * contract has accumulated.
 *
 * Pairing
 * -------
 * A contract's policy file is resolved from the parameter file's own
 * `loadTextContent(...)` argument rather than by guessing at sibling .xml
 * files, so the pairing stays correct even when a contract names its policy
 * differently. Creation wires this link explicitly (see `createContract`).
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

import { repoRoot, assertInsideRepo } from './config.mjs';
import { parseBicepParam } from './bicepparam/parser.mjs';
import { buildOutline } from './doclayer.mjs';

export const CONTRACT_ROOT = 'bicep/infra/citadel-access-contracts';

/** Folders inside the module that are plumbing, not contracts. */
const EXCLUDED = new Set(['modules', 'policies', 'base-contracts', '.backups']);

/** The fixed pair every new contract is created from. */
export const TEMPLATE = {
  id: '__template',
  paramFile: `${CONTRACT_ROOT}/main.bicepparam`,
  policyFile: `${CONTRACT_ROOT}/policies/default-ai-product-policy.xml`,
};

/** Filename a copied policy takes inside a contract folder. */
const CONTRACT_POLICY_NAME = 'ai-product-policy.xml';

/** Folder new contracts are created under, relative to the module root. */
const CONTRACT_PARENT = 'contracts';

/**
 * Where recoverable copies of contracts live.
 *
 * Inside CitadelUI on purpose: the contracts folder itself is git-ignored and
 * has proven to be removable by things outside this app, so the safety copy has
 * to sit somewhere that is not the thing being protected.
 */
const SNAPSHOT_ROOT = 'CitadelUI/.snapshots';

function toPosix(p) {
  return p.split('\\').join('/');
}

function abs(rel) {
  return assertInsideRepo(join(repoRoot, rel));
}

/* -------------------------------------------------------------- discovery */

function walk(dirRel, out) {
  let entries;
  try {
    entries = readdirSync(abs(dirRel), { withFileTypes: true });
  } catch {
    return;
  }

  const paramFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.bicepparam'));
  if (paramFiles.length) {
    // Prefer main.bicepparam when a folder carries several.
    const primary = paramFiles.find((e) => e.name === 'main.bicepparam') || paramFiles[0];
    out.push({ dirRel, fileName: primary.name });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED.has(entry.name)) continue;
    walk(toPosix(join(dirRel, entry.name)), out);
  }
}

/**
 * Resolve the policy file a parameter document loads.
 * Returns a repo-relative path, or null when the contract loads no policy.
 */
function resolvePolicy(doc, dirRel) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'call') {
      if (node.callee === 'loadTextContent' && node.args && node.args[0]) {
        const arg = node.args[0];
        if (arg.kind === 'string' && arg.value) {
          found.push(arg.value);
          return;
        }
      }
      if (node.args) node.args.forEach(visit);
      return;
    }
    if (node.kind === 'array') node.items.forEach(visit);
    else if (node.kind === 'object') node.properties.forEach((p) => visit(p.value));
  };
  for (const p of doc.params) visit(p.value);

  for (const rel of found) {
    const candidate = toPosix(join(dirRel, rel));
    if (existsSync(join(repoRoot, candidate))) return candidate;
  }
  return found.length ? toPosix(join(dirRel, found[0])) : null;
}

function contractId(dirRel) {
  const rel = toPosix(relative(CONTRACT_ROOT, dirRel));
  return rel && rel !== '.' ? rel : '';
}

function humanise(rel) {
  const last = rel.split('/').filter(Boolean).pop() || rel;
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function describe(dirRel, fileName, extra = {}) {
  const paramRel = toPosix(join(dirRel, fileName));
  const id = extra.id ?? contractId(dirRel);
  let policy = null;
  let paramCount = 0;
  let error = null;
  try {
    const doc = parseBicepParam(readFileSync(abs(paramRel), 'utf8'));
    paramCount = doc.params.length;
    policy = resolvePolicy(doc, dirRel);
  } catch (err) {
    error = err.message;
  }
  if (extra.policyFile) policy = extra.policyFile;

  return {
    id,
    name: extra.name ?? humanise(id),
    dir: toPosix(dirRel),
    paramFile: paramRel,
    policyFile: policy,
    hasPolicy: Boolean(policy && existsSync(join(repoRoot, policy))),
    paramCount,
    isTemplate: Boolean(extra.isTemplate),
    modifiedMs: statSync(abs(paramRel)).mtimeMs,
    error,
  };
}

/**
 * List every access contract in the module, with the fixed template first.
 *
 * The template is included in the catalogue because both of its files are
 * editable: changing them changes the starting point of every future contract.
 * It is flagged so the UI can present it distinctly from real contracts.
 */
export function listContracts() {
  const found = [];
  walk(CONTRACT_ROOT, found);

  const contracts = found
    // The module root holds the template, not a contract.
    .filter(({ dirRel }) => contractId(dirRel) !== '')
    .map(({ dirRel, fileName }) => describe(dirRel, fileName))
    .sort((a, b) => a.id.localeCompare(b.id));

  const template = describe(CONTRACT_ROOT, 'main.bicepparam', {
    id: TEMPLATE.id,
    name: 'Template',
    policyFile: TEMPLATE.policyFile,
    isTemplate: true,
  });

  return {
    root: CONTRACT_ROOT,
    parent: CONTRACT_PARENT,
    template,
    contracts: [template, ...contracts],
  };
}

/* ------------------------------------------------------------------- read */

export function readContract(id) {
  const { contracts } = listContracts();
  const entry = contracts.find((c) => c.id === id);
  if (!entry) throw Object.assign(new Error(`Unknown access contract: ${id}`), { status: 404 });

  const paramText = readFileSync(abs(entry.paramFile), 'utf8');
  const doc = parseBicepParam(paramText);
  const paramStat = statSync(abs(entry.paramFile));

  let policy = null;
  if (entry.policyFile && existsSync(join(repoRoot, entry.policyFile))) {
    const text = readFileSync(abs(entry.policyFile), 'utf8');
    policy = {
      path: entry.policyFile,
      name: basename(entry.policyFile),
      text,
      mtimeMs: statSync(abs(entry.policyFile)).mtimeMs,
      controls: readPolicyControls(text),
    };
  }

  return {
    ...entry,
    param: {
      path: entry.paramFile,
      text: paramText,
      mtimeMs: paramStat.mtimeMs,
      size: paramStat.size,
      using: doc.using ? doc.using.path : null,
      params: doc.params.map((p) => ({
        name: p.name,
        kind: p.value.kind,
        span: { start: p.value.start, end: p.value.end },
        raw: paramText.slice(p.value.start, p.value.end),
      })),
      outline: buildOutline(paramText, doc.params),
    },
    policy,
  };
}

/* --------------------------------------------------------- policy reading */

/** Character ranges covered by XML comments, so scans can ignore them. */
function commentRanges(xml) {
  const ranges = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(xml))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(ranges, index) {
  return ranges.some(([s, e]) => index >= s && index < e);
}

/**
 * The line ending the file already uses.
 *
 * Inserted markup has to match it. The repository is CRLF, and splicing bare
 * LF into it leaves a file with mixed endings that shows up as a whole-file
 * change in git even though only one line was added.
 */
function eolOf(xml) {
  return xml.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Widen an element span to the whitespace that exists only to lay it out.
 *
 * Removing an element by its own span alone leaves the indent behind as a line
 * of trailing spaces, which every later read then has to tolerate.
 */
function lineSpan(xml, span) {
  const lead = /[ \t]*$/.exec(xml.slice(0, span.start))[0];
  const before = span.start - lead.length;
  const onOwnLine = before === 0 || xml[before - 1] === '\n';
  const trail = /^[ \t]*\r?\n/.exec(xml.slice(span.end));
  return {
    start: onOwnLine ? before : span.start,
    end: onOwnLine && trail ? span.end + trail[0].length : span.end,
  };
}

/**
 * The `set-variable` knobs the gateway's policy fragments read.
 *
 * Names and semantics are taken from citadel-access-contracts-policy.md; each
 * one is a documented contract between a product policy and a shared fragment,
 * so the set is fixed rather than free-form. Grouping them here lets a single
 * reader/writer pair handle every switch without a bespoke regex each time.
 *
 * `insertable` marks a knob that may be added to a policy that does not carry
 * it yet -- the common case, since the template ships only the few it needs.
 */
export const POLICY_VARIABLES = [
  { key: 'jwtRequired', type: 'boolean', group: 'security', label: 'Require a JWT', help: 'Callers must send Authorization: Bearer <token> as well as the subscription key. Validated by the security-handler fragment.' },
  { key: 'jwtAudience', type: 'string', group: 'security', label: 'Audience override', help: 'Overrides the gateway-level audience for this product only.' },
  { key: 'jwtIssuer', type: 'string', group: 'security', label: 'Issuer override', help: 'Overrides the gateway-level issuer for this product only.' },
  { key: 'jwtOpenIdConfigUrl', type: 'string', group: 'security', label: 'OpenID config URL', help: 'Discovery document used to fetch signing keys.' },
  { key: 'requiredRoles', type: 'string', group: 'security', label: 'Required app roles', help: 'Comma-separated. The caller needs at least one of these roles in the token (OR logic). Requires a JWT.' },

  { key: 'piiAnonymizationEnabled', type: 'boolean', group: 'pii', label: 'Anonymize PII', help: 'Replace detected entities before the request reaches the model.' },
  { key: 'piiBlockingEnabled', type: 'boolean', group: 'pii', label: 'Block on detection', help: 'Reject the request outright instead of anonymizing it.' },
  { key: 'piiStateSavingEnabled', type: 'boolean', group: 'pii', label: 'Restore in response', help: 'Keep the mapping so the original values can be put back into the completion.' },
  { key: 'piiConfidenceThreshold', type: 'number', group: 'pii', label: 'Confidence threshold', help: 'Lowest detection confidence that counts, 0 to 1. Lower catches more and misfires more.' },
  { key: 'piiDetectionLanguage', type: 'string', group: 'pii', label: 'Detection language', help: 'Two-letter language code passed to the detector, for example en.' },
  { key: 'piiEntityCategoryExclusions', type: 'string', group: 'pii', label: 'Excluded categories', help: 'Comma-separated entity categories to ignore, for example PersonType.' },

  { key: 'alertOnThrottling', type: 'boolean', group: 'alerts', label: 'Throttling (429)', help: 'Raise an App Insights event when a caller is throttled.' },
  { key: 'alertOnAuthFailure', type: 'boolean', group: 'alerts', label: 'Auth failure', help: 'Raise an event when JWT or role validation rejects a caller.' },
  { key: 'alertOnContentSafety', type: 'boolean', group: 'alerts', label: 'Content safety block', help: 'Raise an event when content safety rejects a request.' },
  { key: 'alertOnPiiFailure', type: 'boolean', group: 'alerts', label: 'PII failure', help: 'Raise an event when PII handling fails closed with a 502.' },

  { key: 'enableResponseHeaders', type: 'boolean', group: 'headers', label: 'Response headers', help: 'Return remaining-token headers so clients can back off before being throttled.' },
];

const VARIABLE_BY_KEY = new Map(POLICY_VARIABLES.map((v) => [v.key, v]));

/**
 * Read one `set-variable` knob, tolerating both the plain and the `@(...)`
 * expression form the templates mix, and treating a commented-out declaration
 * as "off but configured" rather than as absent.
 *
 * A live declaration always wins over a commented one, whatever their order in
 * the file: policies routinely carry a commented example above the real switch,
 * and reporting the example would both mislead the screen and aim a write at
 * text inside a comment.
 */
function readVariable(xml, key, comments) {
  const re = new RegExp(
    `(<!--\\s*)?<set-variable\\s+name="${key}"\\s+value="(@\\()?([^"]*?)(\\))?"\\s*/>(\\s*-->)?`,
    'g'
  );

  let fallback = null;
  let m;
  while ((m = re.exec(xml))) {
    const valueStart = m.index + m[0].indexOf('value="') + 7 + (m[2] ? m[2].length : 0);
    const raw = m[3];
    const commented = Boolean(m[1]) || inRanges(comments, m.index);
    const found = {
      present: true,
      commented,
      expression: Boolean(m[2]),
      value: raw,
      span: { start: valueStart, end: valueStart + raw.length },
      elementSpan: { start: m.index, end: m.index + m[0].length },
    };
    if (!commented) return found;
    if (!fallback) fallback = found;
  }

  return fallback;
}

/** Request-count throttles, used for tool and agent assets where tokens do not exist. */
function readCallLimit(xml, tag) {
  const re = new RegExp(`(<!--\\s*)?(<${tag}\\b[^>]*?/>)(\\s*-->)?`);
  const m = re.exec(xml);
  if (!m) return null;
  const body = m[2];
  const bodyStart = m.index + (m[1] ? m[1].length : 0);
  const attributes = {};
  const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(body))) {
    const end = bodyStart + a.index + a[0].length - 1;
    attributes[a[1]] = { value: a[2], span: { start: end - a[2].length, end } };
  }
  return {
    enabled: !m[1],
    attributes,
    span: { start: m.index, end: m.index + m[0].length },
    bodySpan: { start: bodyStart, end: bodyStart + body.length },
  };
}

/**
 * The severity categories the content safety policy can score.
 *
 * Fixed to what Azure AI Content Safety actually classifies (see the
 * llm-content-safety policy reference linked from
 * citadel-access-contracts-policy.md); a name outside this set is silently
 * ignored by the service, so offering one would be a lie.
 */
export const CONTENT_SAFETY_CATEGORIES = ['Hate', 'SelfHarm', 'Sexual', 'Violence'];

/** How Azure AI Content Safety reports severity (`categories/@output-type`). */
export const CONTENT_SAFETY_OUTPUT_TYPES = ['FourSeverityLevels', 'EightSeverityLevels'];

/**
 * The two request-count throttles, which are routinely confused.
 *
 * `rate-limit-by-key` is a **sliding** window capped at 300 seconds. It exists
 * to flatten bursts, and a caller that trips it can retry shortly after.
 * `quota-by-key` is a **fixed** window with a 300 second floor and no ceiling.
 * It is the long-term allowance, and tripping it usually means waiting for the
 * period to roll over. They are complementary, which is why the accelerator's
 * tool and agent contracts set both.
 *
 * Attributes and limits come from the API Management policy reference rather
 * than from the accelerator's examples, which show only the few they use.
 */
export const THROTTLE_SPECS = {
  rateLimit: {
    tag: 'rate-limit-by-key',
    window: 'Sliding window, 300 seconds maximum. Smooths bursts; a throttled caller can retry soon after.',
    fields: [
      { key: 'calls', type: 'number', required: true, label: 'Calls', help: 'Maximum calls allowed for one counter key within the renewal period.' },
      { key: 'renewal-period', type: 'number', required: true, label: 'Renewal period (seconds)', max: 300, help: 'Length of the sliding window. Maximum 300 seconds -- longer allowances belong in the request quota.' },
      { key: 'counter-key', type: 'string', required: true, label: 'Counter key', help: 'Everything sharing this key shares the budget. One counter is kept per key value across every scope that uses it.' },
      { key: 'increment-condition', type: 'string', label: 'Increment condition', help: 'Boolean expression deciding whether a request counts. Using an expression defers the count to the end of the outbound pipeline.' },
      { key: 'increment-count', type: 'number', label: 'Increment count', help: 'How much each request adds to the counter. Defaults to 1.' },
      { key: 'retry-after-header-name', type: 'string', label: 'Retry-after header', help: 'Response header carrying the recommended retry interval. Defaults to Retry-After.' },
      { key: 'remaining-calls-header-name', type: 'string', label: 'Remaining-calls header', help: 'Response header carrying how many calls remain, so clients can back off before being throttled.' },
      { key: 'total-calls-header-name', type: 'string', label: 'Total-calls header', help: 'Response header carrying the configured call ceiling.' },
    ],
  },
  callQuota: {
    tag: 'quota-by-key',
    window: 'Fixed window, 300 seconds minimum; zero never resets. The long-term allowance.',
    fields: [
      { key: 'calls', type: 'number', label: 'Calls', help: 'Maximum calls in the period. Set calls, bandwidth, or both.' },
      { key: 'bandwidth', type: 'number', label: 'Bandwidth (KB)', help: 'Maximum kilobytes in the period. Set calls, bandwidth, or both.' },
      { key: 'renewal-period', type: 'number', required: true, label: 'Renewal period (seconds)', min: 0, help: 'Length of the fixed window. Minimum 300 seconds; 3600 is an hour, 2592000 is 30 days. Zero makes the quota never reset.' },
      { key: 'counter-key', type: 'string', required: true, label: 'Counter key', help: 'Everything sharing this key shares the allowance. Must be unique across APIs unless they are meant to share.' },
      { key: 'first-period-start', type: 'string', label: 'First period start', help: 'Anchor for the fixed windows, as yyyy-MM-ddTHH:mm:ssZ. Defaults to 0001-01-01T00:00:00Z.' },
      { key: 'increment-condition', type: 'string', label: 'Increment condition', help: 'Boolean expression deciding whether a request counts -- commonly used to charge only successful responses.' },
      { key: 'increment-count', type: 'number', label: 'Increment count', help: 'How much each request adds to the counter. Defaults to 1.' },
    ],
  },
};

/**
 * Semantic caching.
 *
 * Lookup sits in `inbound` and store in `outbound`, and the two are only useful
 * together -- a lookup with no store never hits, and a store with no lookup only
 * costs. They are surfaced as one block for that reason.
 *
 * The similarity match means a cached answer can be returned for a prompt that
 * merely resembles the original, so the threshold is a correctness control, not
 * a performance dial.
 */
export const SEMANTIC_CACHE_SPEC = {
  lookupTag: 'llm-semantic-cache-lookup',
  storeTag: 'llm-semantic-cache-store',
  lookupFields: [
    { key: 'score-threshold', type: 'number', required: true, label: 'Score threshold', step: '0.01', min: 0, max: 1, help: 'How close an incoming prompt must be to a cached one, from 0.0 to 1.0. Lower demands greater similarity. Start around 0.05; above 0.2 tends to return mismatched answers.' },
    { key: 'embeddings-backend-id', type: 'string', required: true, label: 'Embeddings backend', help: 'APIM backend for the embeddings API used to compare prompts. It needs capacity and context length for your prompt volume.' },
    { key: 'embeddings-backend-auth', type: 'enum', required: true, label: 'Embeddings auth', options: ['system-assigned'], help: 'Must be system-assigned; the policy accepts no other value.' },
    { key: 'ignore-system-messages', type: 'boolean', label: 'Ignore system messages', help: 'Recommended. Strips system messages before comparing, so a shared system prompt does not make every request look alike.' },
    { key: 'max-message-count', type: 'number', label: 'Max message count', help: 'Skip caching once the dialog has more than this many remaining messages.' },
  ],
  storeFields: [
    { key: 'duration', type: 'number', required: true, label: 'Cache duration (seconds)', help: 'How long a stored response stays eligible for reuse.' },
  ],
};

/** Content safety, including its per-category severity thresholds. */
function readContentSafety(xml) {
  const re = /(<!--\s*)?(<llm-content-safety\b[\s\S]*?<\/llm-content-safety>)(\s*-->)?/;
  const m = re.exec(xml);
  if (!m) return null;
  const body = m[2];
  const bodyStart = m.index + (m[1] ? m[1].length : 0);

  const attributes = {};
  const head = /<llm-content-safety\b([^>]*)>/.exec(body);
  if (head) {
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(head[1]))) {
      const end = bodyStart + head.index + head[0].indexOf(a[0]) + a[0].length - 1;
      attributes[a[1]] = { value: a[2], span: { start: end - a[2].length, end } };
    }
  }

  const categories = [];
  const catRe = /<category\b([^>]*)\/>/g;
  let c;
  while ((c = catRe.exec(body))) {
    const name = /name="([^"]*)"/.exec(c[1]);
    const threshold = /threshold="([^"]*)"/.exec(c[1]);
    if (!name || !threshold) continue;
    // Locate the value from its own attribute rather than from the end of the
    // match: the trailing `/>` may or may not carry whitespace.
    const attrsStart = bodyStart + c.index + c[0].indexOf(c[1]);
    const valueStart = attrsStart + threshold.index + 'threshold="'.length;
    categories.push({
      name: name[1],
      threshold: threshold[1],
      span: { start: valueStart, end: valueStart + threshold[1].length },
      elementSpan: { start: bodyStart + c.index, end: bodyStart + c.index + c[0].length },
    });
  }

  // Where an added category goes: after the last one so the list keeps its
  // order, or straight after the opening <categories> tag when there is none.
  let categoryInsertAt = null;
  if (categories.length) {
    categoryInsertAt = categories[categories.length - 1].elementSpan.end;
  } else {
    const open = /<categories\b[^>]*>/.exec(body);
    if (open) categoryInsertAt = bodyStart + open.index + open[0].length;
  }
  const anchor = categories.length ? categories[categories.length - 1].elementSpan.start : categoryInsertAt;
  const categoryIndent = anchor === null ? '' : /[ \t]*$/.exec(xml.slice(0, anchor))[0];

  // `output-type` lives on <categories>, not on the policy element, so it needs
  // its own span rather than riding along with the attributes above.
  let outputType = null;
  const cats = /<categories\b([^>]*)>/.exec(body);
  if (cats) {
    const ot = /output-type="([^"]*)"/.exec(cats[1]);
    if (ot) {
      const start =
        bodyStart + cats.index + cats[0].indexOf(cats[1]) + ot.index + 'output-type="'.length;
      outputType = { value: ot[1], span: { start, end: start + ot[1].length } };
    } else {
      outputType = { value: 'FourSeverityLevels', span: null };
    }
  }

  // Blocklists are named in the Content Safety resource; the policy only
  // references them by id, so they are edited here as a list of names.
  const blocklists = [];
  const listBlock = /<blocklists>([\s\S]*?)<\/blocklists>/.exec(body);
  if (listBlock) {
    const inner = listBlock[1];
    const innerStart = bodyStart + listBlock.index + listBlock[0].indexOf(inner);
    const idRe = /<id>([\s\S]*?)<\/id>/g;
    let idm;
    while ((idm = idRe.exec(inner))) {
      const valueStart = innerStart + idm.index + '<id>'.length;
      blocklists.push({
        id: idm[1],
        span: { start: valueStart, end: valueStart + idm[1].length },
        elementSpan: { start: innerStart + idm.index, end: innerStart + idm.index + idm[0].length },
      });
    }
  }

  return {
    enabled: !m[1],
    attributes,
    categories,
    categoryInsertAt,
    categoryIndent,
    outputType,
    blocklists,
    blocklistBlock: listBlock
      ? {
          start: bodyStart + listBlock.index,
          end: bodyStart + listBlock.index + listBlock[0].length,
          insertAt: blocklists.length
            ? blocklists[blocklists.length - 1].elementSpan.end
            : bodyStart + listBlock.index + listBlock[0].indexOf(listBlock[1]),
        }
      : null,
    // A <blocklists> element must follow </categories>, per the documented
    // element order, so the insertion point is anchored to that rather than to
    // wherever the policy element happens to end.
    blocklistInsertAt: (() => {
      const close = body.indexOf('</categories>');
      if (close !== -1) return bodyStart + close + '</categories>'.length;
      const open = /<llm-content-safety\b[^>]*>/.exec(body);
      return open ? bodyStart + open.index + open[0].length : null;
    })(),
    // XML comments do not nest, so a block carrying its own comments cannot be
    // disabled by wrapping it in one without breaking the document.
    hasInnerComment: body.includes('<!--'),
    span: { start: m.index, end: m.index + m[0].length },
    bodySpan: { start: bodyStart, end: bodyStart + body.length },
  };
}

/**
 * Semantic caching, read as one block.
 *
 * Lookup and store are separate elements in separate pipeline sections, but
 * neither is useful alone, so they are reported together and the UI can say
 * when only half of the pair is present.
 */
function readSemanticCache(xml) {
  const read = (tag) => {
    const re = new RegExp(`(<!--\\s*)?(<${tag}\\b[\\s\\S]*?(?:/>|</${tag}>))(\\s*-->)?`);
    const m = re.exec(xml);
    if (!m) return null;
    const body = m[2];
    const bodyStart = m.index + (m[1] ? m[1].length : 0);
    const attributes = {};
    const head = new RegExp(`<${tag}\\b([^>]*)>`).exec(body);
    if (head) {
      const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = attrRe.exec(head[1]))) {
        const end = bodyStart + head.index + head[0].indexOf(a[0]) + a[0].length - 1;
        attributes[a[1]] = { value: a[2], span: { start: end - a[2].length, end } };
      }
    }
    const varyBy = [];
    const vRe = /<vary-by>([\s\S]*?)<\/vary-by>/g;
    let v;
    while ((v = vRe.exec(body))) {
      const start = bodyStart + v.index + '<vary-by>'.length;
      varyBy.push({
        value: v[1],
        span: { start, end: start + v[1].length },
        elementSpan: { start: bodyStart + v.index, end: bodyStart + v.index + v[0].length },
      });
    }
    return {
      enabled: !m[1],
      attributes,
      varyBy,
      hasInnerComment: body.includes('<!--'),
      span: { start: m.index, end: m.index + m[0].length },
      bodySpan: { start: bodyStart, end: bodyStart + body.length },
    };
  };

  const lookup = read(SEMANTIC_CACHE_SPEC.lookupTag);
  const store = read(SEMANTIC_CACHE_SPEC.storeTag);
  if (!lookup && !store) return null;
  return { lookup, store };
}

/**
 * Token limits, as a structure rather than as a single element.
 *
 * The policy guide describes three real shapes, and a contract can be in any
 * of them (citadel-access-contracts-policy.md, "Model Capacity Management"):
 *
 *   universal  a bare <llm-token-limit>; every model shares one budget
 *   per-model  a <choose> with one <when> per model and no <otherwise>;
 *              models with no <when> are not limited at all
 *   mixed      a <choose> with per-model <when>s plus an <otherwise> that
 *              catches everything else -- the common production shape
 *
 * The <when> condition is what names the model, so it is parsed rather than
 * inferred: the counter-key is free text and cannot be trusted to identify it.
 */
function readLimitElement(xml, elementStart, elementEnd, commented) {
  const body = xml.slice(elementStart, elementEnd);
  const attributes = {};
  const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(body))) {
    const end = elementStart + m.index + m[0].length - 1;
    attributes[m[1]] = { value: m[2], span: { start: end - m[2].length, end } };
  }
  return { attributes, commented, span: { start: elementStart, end: elementEnd } };
}

/**
 * The model a per-model `<when>` selects.
 *
 * The same condition legitimately appears in two forms. The guide writes it
 * with raw quotes (`context.Variables["requestedModel"] == "gpt-4o"`), while a
 * `<when>` written by this editor is XML-escaped, so the brackets are followed
 * by `&quot;` instead. Matching only one form is what made an added limit read
 * back nameless -- and therefore impossible to remove again, since removal is
 * keyed off the parsed name.
 */
const WHEN_MODEL = /requestedModel(?:&quot;|")?\s*[\])]\s*==\s*(?:&quot;|")([^&"<]+)(?:&quot;|")/;

function modelFromCondition(condition) {
  const m = WHEN_MODEL.exec(condition || '');
  return m ? m[1].trim() : null;
}

/**
 * Read a throttle in whichever of the three shapes the policy uses.
 *
 * Token limits and request-count limits differ only in the element they wrap:
 * `llm-token-limit` meters tokens, `rate-limit-by-key` and `quota-by-key` meter
 * calls, and the markdown shows all of them driven per model by the same
 * `<choose>` on `requestedModel`. One reader serves all three, so per-model
 * support cannot drift between them.
 *
 * `<choose>` blocks are matched by the element they contain, not by position,
 * because a policy may carry several -- a token `<choose>` and a call `<choose>`
 * side by side.
 */
function readLimitStructure(xml, tag) {
  const perModel = [];
  let universal = null;

  const chooseRe = /<choose>[\s\S]*?<\/choose>/g;
  const elementRe = new RegExp(`<${tag}\\b[\\s\\S]*?/>`);
  let choose = null;
  let c;
  while ((c = chooseRe.exec(xml))) {
    if (elementRe.test(c[0])) {
      choose = c;
      break;
    }
  }

  if (choose) {
    const chooseSpan = { start: choose.index, end: choose.index + choose[0].length };
    const block = choose[0];

    // The condition itself may contain raw quotes, so the attribute cannot be
    // read as "everything up to the next quote" -- take everything up to the
    // quote that actually closes the tag.
    const whenRe = /<when\s+condition="([\s\S]*?)"\s*>([\s\S]*?)<\/when>/g;
    let w;
    while ((w = whenRe.exec(block))) {
      const limit = new RegExp(`<${tag}\\b[\\s\\S]*?/>`).exec(w[2]);
      if (!limit) continue;
      const start = choose.index + w.index + w[0].indexOf(w[2]) + w[2].indexOf(limit[0]);
      perModel.push({
        model: modelFromCondition(w[1]),
        condition: w[1],
        ...readLimitElement(xml, start, start + limit[0].length, false),
        whenSpan: { start: choose.index + w.index, end: choose.index + w.index + w[0].length },
      });
    }

    const other = /<otherwise>([\s\S]*?)<\/otherwise>/.exec(block);
    if (other) {
      const limit = new RegExp(`<${tag}\\b[\\s\\S]*?/>`).exec(other[1]);
      if (limit) {
        const start = choose.index + other.index + other[0].indexOf(other[1]) + other[1].indexOf(limit[0]);
        universal = {
          ...readLimitElement(xml, start, start + limit[0].length, false),
          inOtherwise: true,
          otherwiseSpan: { start: choose.index + other.index, end: choose.index + other.index + other[0].length },
        };
      }
    }
    return { tag, mode: universal ? 'mixed' : 'per-model', universal, perModel, chooseSpan };
  }

  const bare = new RegExp(`(<!--\\s*)?(<${tag}\\b[\\s\\S]*?/>)(\\s*-->)?`).exec(xml);
  if (bare) {
    const start = bare.index + (bare[1] ? bare[1].length : 0);
    universal = {
      ...readLimitElement(xml, start, start + bare[2].length, Boolean(bare[1])),
      inOtherwise: false,
      wrapperSpan: { start: bare.index, end: bare.index + bare[0].length },
    };
  }
  return { tag, mode: 'universal', universal, perModel: [], chooseSpan: null };
}

function readTokenLimits(xml) {
  return readLimitStructure(xml, 'llm-token-limit');
}

/** Render one throttle element from plain attribute values. */
function renderLimit(attributes, tag = 'llm-token-limit') {
  const order = [
    'counter-key',
    'calls',
    'renewal-period',
    'tokens-per-minute',
    'estimate-prompt-tokens',
    'token-quota',
    'token-quota-period',
    'tokens-consumed-header-name',
    'remaining-tokens-header-name',
    'retry-after-header-name',
  ];
  const keys = [...new Set([...order, ...Object.keys(attributes)])].filter((k) => attributes[k] !== undefined);
  const attrs = keys.map((k) => `${k}="${escapeAttr(String(attributes[k]))}"`).join(' ');
  return `<${tag} ${attrs} />`;
}

/**
 * Attribute values as written in the file, decoded to their logical form.
 *
 * Spans carry the escaped text, and `renderLimit` escapes what it is given, so
 * passing the raw value straight through would double-encode a counter key that
 * contains quotes -- `&quot;` becoming `&amp;quot;` and the expression breaking
 * silently at deployment time.
 */
function plainAttributes(limit) {
  const out = {};
  for (const [k, v] of Object.entries(limit.attributes)) out[k] = unescapeAttr(v.value);
  return out;
}

/**
 * Surface the "dynamic policy attributes" the contract template calls out, so
 * they can be edited as fields instead of by hand-editing XML.
 *
 * Each control records the exact character span of the value it owns; writes
 * splice only that span, leaving the rest of the policy -- including its
 * comments and any hand-written rules -- byte-identical.
 */
export function readPolicyControls(xml) {
  const controls = {};
  const comments = commentRanges(xml);

  const allowed = /(<set-variable\s+name="allowedModels"\s+value=")([^"]*)(")/.exec(xml);
  if (allowed) {
    const start = allowed.index + allowed[1].length;
    controls.allowedModels = {
      value: allowed[2],
      models: allowed[2].split(',').map((s) => s.trim()).filter(Boolean),
      span: { start, end: start + allowed[2].length },
    };
  }

  // The token limit ships commented out in some policies; treat the commented
  // form as "disabled" rather than "absent" so the UI can offer a toggle
  // instead of asking the user to write XML.
  const limit = /(<!--\s*)?(<llm-token-limit\b[\s\S]*?\/>)(\s*-->)?/.exec(xml);
  if (limit) {
    const body = limit[2];
    const bodyStart = limit.index + (limit[1] ? limit[1].length : 0);
    const attributes = {};
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(body))) {
      const valueEnd = bodyStart + m.index + m[0].length - 1;
      attributes[m[1]] = {
        value: m[2],
        span: { start: valueEnd - m[2].length, end: valueEnd },
      };
    }
    controls.tokenLimit = {
      enabled: !limit[1],
      span: { start: limit.index, end: limit.index + limit[0].length },
      bodySpan: { start: bodyStart, end: bodyStart + body.length },
      attributes,
    };
  }

  const headers = /(<set-variable\s+name="enableResponseHeaders"\s+value="@\()(true|false)(\)")/.exec(xml);
  if (headers) {
    const start = headers.index + headers[1].length;
    controls.responseHeaders = {
      value: headers[2] === 'true',
      span: { start, end: start + headers[2].length },
    };
  }

  // Report only live fragments; commented-out examples are documentation.
  const fragments = [];
  const fragRe = /<include-fragment\s+fragment-id="([^"]+)"/g;
  let f;
  while ((f = fragRe.exec(xml))) {
    if (!inRanges(comments, f.index)) fragments.push(f[1]);
  }
  controls.fragments = fragments;

  // Every documented knob, whether the policy carries it or not: the UI needs
  // to offer the absent ones as switches to add rather than hide them.
  controls.variables = {};
  for (const def of POLICY_VARIABLES) {
    const found = readVariable(xml, def.key, comments);
    controls.variables[def.key] = found || { present: false, commented: false, value: null };
  }

  controls.contentSafety = readContentSafety(xml);
  controls.semanticCache = readSemanticCache(xml);
  controls.tokenLimits = readTokenLimits(xml);
  controls.rateLimit = readCallLimit(xml, 'rate-limit-by-key');
  controls.callQuota = readCallLimit(xml, 'quota-by-key');
  // Call-based throttles support the same universal / per-model / mixed shapes
  // as token limits, so they are read structurally too. The flat reads above
  // stay for the enable/disable and attribute paths that already use them.
  controls.rateLimits = readLimitStructure(xml, 'rate-limit-by-key');
  controls.quotaLimits = readLimitStructure(xml, 'quota-by-key');

  // Where a newly enabled knob gets written. The template's own header comment
  // mentions `<inbound>`, so the first textual match is not the real element --
  // take the first one that is not inside a comment.
  controls.insertAt = null;
  const inboundRe = /<inbound>[ \t]*\r?\n?(\s*<base\s*\/>)?/g;
  let ib;
  while ((ib = inboundRe.exec(xml))) {
    if (inRanges(comments, ib.index)) continue;
    controls.insertAt = ib.index + ib[0].length;
    break;
  }

  return controls;
}

/* ------------------------------------------------------------ policy write */

/** Apply splices back to front so earlier offsets stay valid. */
function spliceAll(xml, splices) {
  let out = xml;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/** Indentation of a direct child of `<inbound>` in the shipped policies. */
const INBOUND_INDENT = '        ';

function asList(...values) {
  return values.flat().filter((v) => v !== undefined && v !== null && v !== '');
}

/**
 * The documented starting point for a block the policy does not carry yet.
 *
 * Every attribute and default here is taken from
 * citadel-access-contracts-policy.md, so enabling a block from the UI writes
 * exactly the snippet the guide tells an operator to paste. The blocks
 * deliberately carry no inner comments: XML comments do not nest, so a block
 * with one inside could never be commented out again.
 */
function defaultBlock(name, eol) {
  const i = INBOUND_INDENT;
  if (name === 'contentSafety') {
    return (
      `${eol}${i}<llm-content-safety backend-id="content-safety-backend" shield-prompt="true"` +
      ` enforce-on-completions="false">` +
      `${eol}${i}    <categories output-type="EightSeverityLevels">` +
      `${eol}${i}        <category name="Hate" threshold="4" />` +
      `${eol}${i}        <category name="SelfHarm" threshold="4" />` +
      `${eol}${i}        <category name="Sexual" threshold="4" />` +
      `${eol}${i}        <category name="Violence" threshold="4" />` +
      `${eol}${i}    </categories>` +
      `${eol}${i}</llm-content-safety>`
    );
  }
  if (name === 'semanticCache') {
    // Lookup belongs in inbound. The matching store lives in outbound and is
    // inserted separately, because a lookup with no store never hits.
    return (
      `${eol}${i}<llm-semantic-cache-lookup score-threshold="0.05"` +
      ` embeddings-backend-id="embeddings-backend" embeddings-backend-auth="system-assigned"` +
      ` ignore-system-messages="true">` +
      `${eol}${i}    <vary-by>@(context.Subscription.Id)</vary-by>` +
      `${eol}${i}</llm-semantic-cache-lookup>`
    );
  }
  if (name === 'rateLimit') {
    return (
      `${eol}${i}<rate-limit-by-key calls="60" renewal-period="60"` +
      ` counter-key="@(context.Subscription.Id + &quot;:tool&quot;)" />`
    );
  }
  if (name === 'callQuota') {
    return (
      `${eol}${i}<quota-by-key calls="100000" renewal-period="2592000"` +
      ` counter-key="@(context.Subscription.Id + &quot;:tool&quot;)" />`
    );
  }
  return null;
}

/**
 * Pass one: create the controls a change refers to but the file does not have.
 *
 * Nothing here edits an existing value. A control that does not exist yet has
 * no span, so any change addressing one by span has to run against the text
 * this pass produces rather than against the original. Every insertion is
 * idempotent (it checks first whether the thing is already there), which lets
 * the caller run the pass repeatedly until a chain such as "enable content
 * safety, then add a category to it" has settled.
 */
function insertMissingControls(xml, changes) {
  const controls = readPolicyControls(xml);
  const eol = eolOf(xml);
  const splices = [];

  if (changes.variables) {
    for (const [key, next] of Object.entries(changes.variables)) {
      if (next === null || !VARIABLE_BY_KEY.has(key)) continue;
      const def = VARIABLE_BY_KEY.get(key);
      const found = controls.variables[key];
      if (found && found.present && !found.commented) continue;
      const text = def.type === 'boolean' ? (next ? 'true' : 'false') : escapeAttr(String(next));
      const line = `${eol}${INBOUND_INDENT}<set-variable name="${key}" value="${text}" />`;
      if (found && found.present) {
        // Re-declare rather than unwrap: the commented form may sit inside a
        // larger explanatory comment we must not break open.
        splices.push({ start: found.elementSpan.end, end: found.elementSpan.end, text: line });
      } else if (controls.insertAt !== null) {
        splices.push({ start: controls.insertAt, end: controls.insertAt, text: line });
      }
    }
  }

  for (const name of ['contentSafety', 'rateLimit', 'callQuota', 'semanticCache']) {
    const change = changes[name];
    if (!change || !change.enable || controls[name] || controls.insertAt === null) continue;
    splices.push({ start: controls.insertAt, end: controls.insertAt, text: defaultBlock(name, eol) });
  }

  const cs = changes.contentSafety;
  const safety = controls.contentSafety;
  if (cs && safety && safety.categoryInsertAt !== null) {
    for (const name of asList(cs.addCategory, cs.addCategories || [])) {
      if (!CONTENT_SAFETY_CATEGORIES.includes(name)) continue;
      if (safety.categories.some((c) => c.name === name)) continue;
      splices.push({
        start: safety.categoryInsertAt,
        end: safety.categoryInsertAt,
        text: `${eol}${safety.categoryIndent}<category name="${name}" threshold="3" />`,
      });
    }
  }

  // Blocklists are a sibling of <categories>, so an absent <blocklists> element
  // has to be created before an id can be added to it.
  if (cs && safety) {
    const adding = asList(cs.addBlocklist, cs.addBlocklists || []).filter(
      (id) => id && !safety.blocklists.some((b) => b.id === id)
    );
    if (adding.length) {
      if (safety.blocklistBlock) {
        const at = safety.blocklistBlock.insertAt;
        const indent = safety.blocklists.length
          ? /[ \t]*$/.exec(xml.slice(0, safety.blocklists[safety.blocklists.length - 1].elementSpan.start))[0]
          : `${safety.categoryIndent}    `;
        splices.push({
          start: at,
          end: at,
          text: adding.map((id) => `${eol}${indent}<id>${escapeAttr(id)}</id>`).join(''),
        });
      } else if (safety.blocklistInsertAt !== null) {
        const outer = safety.categoryIndent.slice(0, -4) || safety.categoryIndent;
        splices.push({
          start: safety.blocklistInsertAt,
          end: safety.blocklistInsertAt,
          text:
            `${eol}${outer}<blocklists>` +
            adding.map((id) => `${eol}${safety.categoryIndent}<id>${escapeAttr(id)}</id>`).join('') +
            `${eol}${outer}</blocklists>`,
        });
      }
    }
  }

  // The three throttle families share one structure, so they share one code
  // path -- per-model support cannot exist for tokens and quietly not for calls.
  for (const [key, structure] of [
    ['tokenLimits', controls.tokenLimits],
    ['rateLimits', controls.rateLimits],
    ['quotaLimits', controls.quotaLimits],
  ]) {
    const limits = changes[key];
    if (!limits || !structure) continue;
    for (const model of asList(limits.addModel, limits.addModels || [])) {
      if (structure.perModel.some((p) => p.model === model)) continue;
      splices.push(...addPerModelLimit(xml, structure, model, eol));
    }
  }

  return spliceAll(xml, splices);
}

/**
 * Adding the first per-model limit converts a bare throttle element into a
 * `<choose>` whose `<otherwise>` carries the previous universal limit, so the
 * existing budget keeps applying to every model without a rule of its own.
 *
 * The counter key gains the model, because two `<when>` branches sharing one
 * key would share one budget and the per-model split would be a fiction.
 */
function addPerModelLimit(xml, tl, model, eol) {
  const i = INBOUND_INDENT;
  const tag = tl.tag || 'llm-token-limit';
  const fallbackAttrs =
    tag === 'llm-token-limit'
      ? { 'tokens-per-minute': '1000' }
      : { calls: '60', 'renewal-period': '60' };
  const base = tl.universal ? plainAttributes(tl.universal) : fallbackAttrs;
  const attrs = {
    ...base,
    'counter-key': '@(context.Subscription.Id + "-" + context.Variables["requestedModel"])',
  };
  const when =
    `${i}    <when condition="@((string)context.Variables[&quot;requestedModel&quot;] == ` +
    `&quot;${escapeAttr(model)}&quot;)">${eol}` +
    `${i}        ${renderLimit(attrs, tag)}${eol}` +
    `${i}    </when>${eol}`;

  if (tl.chooseSpan) {
    // Insert ahead of <otherwise> when there is one, so the fallback stays last.
    const block = xml.slice(tl.chooseSpan.start, tl.chooseSpan.end);
    const otherIdx = block.indexOf('<otherwise>');
    const at = tl.chooseSpan.start + (otherIdx === -1 ? block.lastIndexOf('</choose>') : otherIdx);
    const indentBack = /[ \t]*$/.exec(xml.slice(0, at))[0].length;
    return [{ start: at - indentBack, end: at, text: when + xml.slice(at - indentBack, at) }];
  }
  if (!tl.universal) return [];

  const target = tl.universal.wrapperSpan || tl.universal.span;
  return [
    {
      start: target.start,
      end: target.end,
      text:
        `<choose>${eol}${when}${i}    <otherwise>${eol}` +
        `${i}        ${renderLimit(plainAttributes(tl.universal), tag)}${eol}` +
        `${i}    </otherwise>${eol}${i}</choose>`,
    },
  ];
}

/**
 * Pass two: rewrite values, and remove structures the user asked to drop.
 *
 * Runs against the text pass one produced, so a value edit aimed at a control
 * that was just created lands on the real element instead of being silently
 * dropped.
 */
function writeControlValues(xml, changes) {
  const controls = readPolicyControls(xml);
  const splices = [];

  if (changes.allowedModels !== undefined && controls.allowedModels) {
    splices.push({ ...controls.allowedModels.span, text: escapeAttr(changes.allowedModels) });
  }

  if (changes.responseHeaders !== undefined && controls.responseHeaders) {
    splices.push({ ...controls.responseHeaders.span, text: changes.responseHeaders ? 'true' : 'false' });
  }

  /**
   * Documented `set-variable` knobs. Setting one back to its default removes
   * the line again rather than leaving inert XML behind.
   */
  if (changes.variables) {
    for (const [key, next] of Object.entries(changes.variables)) {
      const def = VARIABLE_BY_KEY.get(key);
      const found = controls.variables && controls.variables[key];
      if (!def || !found || !found.present) continue;

      if (next === null) {
        if (!found.commented) splices.push({ ...lineSpan(xml, found.elementSpan), text: '' });
        continue;
      }
      if (found.commented) continue;
      splices.push({
        ...found.span,
        text: def.type === 'boolean' ? (next ? 'true' : 'false') : escapeAttr(String(next)),
      });
    }
  }

  for (const [key, structure] of [
    ['tokenLimits', controls.tokenLimits],
    ['rateLimits', controls.rateLimits],
    ['quotaLimits', controls.quotaLimits],
  ]) {
    const limits = changes[key];
    if (!limits || !structure) continue;

    splices.push(
      ...removePerModelLimits(xml, structure, asList(limits.removeModel, limits.removeModels || []))
    );

    for (const [model, attributes] of Object.entries(limits.perModel || {})) {
      const entry = structure.perModel.find((p) => p.model === model);
      if (!entry) continue;
      for (const [attrKey, value] of Object.entries(attributes)) {
        const attr = entry.attributes[attrKey];
        if (attr) splices.push({ ...attr.span, text: escapeAttr(String(value)) });
      }
    }

    // The fallback budget is addressed through the shape rather than through the
    // flat control, which is only ever the first element in the document and so
    // points at a per-model branch once the policy is mixed.
    for (const [attrKey, value] of Object.entries(limits.universal || {})) {
      const attr = structure.universal && structure.universal.attributes[attrKey];
      if (attr) splices.push({ ...attr.span, text: escapeAttr(String(value)) });
    }
  }

  const sc = changes.semanticCache;
  if (sc && controls.semanticCache) {
    const write = (part, values) => {
      if (!part || !values) return;
      for (const [key, value] of Object.entries(values)) {
        const attr = part.attributes[key];
        if (attr) splices.push({ ...attr.span, text: escapeAttr(String(value)) });
      }
    };
    write(controls.semanticCache.lookup, sc.lookup);
    write(controls.semanticCache.store, sc.store);

    for (const [index, value] of Object.entries(sc.varyBy || {})) {
      const entry = controls.semanticCache.lookup && controls.semanticCache.lookup.varyBy[Number(index)];
      if (entry) splices.push({ ...entry.span, text: escapeAttr(String(value)) });
    }

    // Partitions are what keep one caller's -- or one model's -- answers from
    // being served to another, so they are add/removable rather than fixed.
    const lookup = controls.semanticCache.lookup;
    if (lookup) {
      for (const expression of asList(sc.addVaryBy, sc.addVaryBys || [])) {
        if (lookup.varyBy.some((v) => v.value === expression)) continue;
        const anchor = lookup.varyBy.length
          ? lookup.varyBy[lookup.varyBy.length - 1].elementSpan.end
          : null;
        if (anchor === null) continue;
        const indent = /[ \t]*$/.exec(xml.slice(0, lookup.varyBy[lookup.varyBy.length - 1].elementSpan.start))[0];
        splices.push({
          start: anchor,
          end: anchor,
          text: `${eol}${indent}<vary-by>${escapeAttr(expression)}</vary-by>`,
        });
      }
      for (const expression of asList(sc.removeVaryBy, sc.removeVaryBys || [])) {
        const entry = lookup.varyBy.find((v) => v.value === expression);
        // The last partition is never removed: an unpartitioned semantic cache
        // serves every caller from one pool, which is a data-leak, not a tuning
        // choice.
        if (entry && lookup.varyBy.length > 1) {
          splices.push({ ...lineSpan(xml, entry.elementSpan), text: '' });
        }
      }
    }
  }

  for (const name of ['contentSafety', 'rateLimit', 'callQuota']) {
    const control = controls[name];
    const change = changes[name];
    if (!change || !control) continue;
    for (const [key, value] of Object.entries(change.attributes || {})) {
      const attr = control.attributes[key];
      if (attr) splices.push({ ...attr.span, text: escapeAttr(String(value)) });
    }
    for (const [catName, threshold] of Object.entries(change.categories || {})) {
      const cat = (control.categories || []).find((c) => c.name === catName);
      if (cat) splices.push({ ...cat.span, text: escapeAttr(String(threshold)) });
    }
    for (const catName of asList(change.removeCategory, change.removeCategories || [])) {
      const cat = (control.categories || []).find((c) => c.name === catName);
      if (cat) splices.push({ ...lineSpan(xml, cat.elementSpan), text: '' });
    }

    if (name === 'contentSafety') {
      if (change.outputType && control.outputType && control.outputType.span) {
        splices.push({ ...control.outputType.span, text: escapeAttr(String(change.outputType)) });
      }
      for (const id of asList(change.removeBlocklist, change.removeBlocklists || [])) {
        const entry = (control.blocklists || []).find((b) => b.id === id);
        if (!entry) continue;
        // Taking the last id would leave an empty <blocklists>, which the schema
        // does not accept, so the wrapper goes with it.
        const last = control.blocklists.length === 1 && control.blocklistBlock;
        splices.push({
          ...lineSpan(xml, last ? control.blocklistBlock : entry.elementSpan),
          text: '',
        });
      }
    }
  }

  if (changes.tokenLimit && changes.tokenLimit.attributes && controls.tokenLimit) {
    for (const [key, value] of Object.entries(changes.tokenLimit.attributes)) {
      const attr = controls.tokenLimit.attributes[key];
      if (attr) splices.push({ ...attr.span, text: escapeAttr(String(value)) });
    }
  }

  return spliceAll(xml, splices);
}

/**
 * Removing per-model limits, choosing the smallest structural change that
 * leaves valid markup behind.
 *
 * `<when>` branches are counted in the block rather than taken from `perModel`
 * because the multi-asset shape parks tool and agent throttles in the same
 * `<choose>`; destroying those would silently disarm a different control.
 */
function removePerModelLimits(xml, tl, models) {
  const targets = models.map((m) => tl.perModel.find((p) => p.model === m)).filter(Boolean);
  if (!targets.length || !tl.chooseSpan) return [];

  const block = xml.slice(tl.chooseSpan.start, tl.chooseSpan.end);
  const branches = (block.match(/<when\b/g) || []).length;
  if (branches > targets.length) {
    return targets.map((entry) => ({ ...lineSpan(xml, entry.whenSpan), text: '' }));
  }

  if (tl.universal && tl.universal.inOtherwise) {
    // Nothing model-specific is left, so collapse back to a bare limit.
    return [
      {
        start: tl.chooseSpan.start,
        end: tl.chooseSpan.end,
        text: renderLimit(plainAttributes(tl.universal), tl.tag),
      },
    ];
  }
  // A <choose> with no branches left would be dead markup.
  return [{ ...lineSpan(xml, tl.chooseSpan), text: '' }];
}

/**
 * Pass three: comment a block out, or bring it back.
 *
 * Last because it rewrites whole elements: by now the body already carries
 * every value edit, so a disabled block keeps the numbers the user configured
 * and can be re-enabled unchanged. Attribute readers match commented elements
 * too, which is what makes that survival visible in the UI.
 */
function toggleControlComments(xml, changes) {
  const controls = readPolicyControls(xml);
  const splices = [];

  for (const name of ['tokenLimit', 'contentSafety', 'rateLimit', 'callQuota']) {
    const control = controls[name];
    const change = changes[name];
    if (!change || !control || change.enabled === undefined) continue;
    if (change.enabled === control.enabled) continue;
    // A block containing a comment cannot be wrapped in one: XML comments do
    // not nest, and producing invalid markup is worse than ignoring the click.
    if (!change.enabled && control.hasInnerComment) continue;

    const body = xml.slice(control.bodySpan.start, control.bodySpan.end);
    splices.push({
      start: control.span.start,
      end: control.span.end,
      text: change.enabled ? body : `<!-- ${body} -->`,
    });
  }

  return spliceAll(xml, splices);
}

/**
 * Apply structured policy changes as span splices.
 *
 * Three passes, each re-reading the document the previous one produced:
 * create, then write, then toggle. A single pass cannot do this, because a
 * change may refer to a control that only exists once an earlier change has
 * been applied -- the reason editing a freshly added per-model limit used to
 * be dropped without a word.
 */
export function applyPolicyChanges(xml, changes) {
  let out = xml;
  // Creation is idempotent, so repeating it settles chains such as "enable
  // content safety, then add a category to it" that arrive as one payload.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = insertMissingControls(out, changes);
    if (next === out) break;
    out = next;
  }
  out = writeControlValues(out, changes);
  return toggleControlComments(out, changes);
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The inverse of escapeAttr, for values read back out of the file. */
function unescapeAttr(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ----------------------------------------------------------------- create */

const NAME_RULE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/**
 * Collect splices that repoint every empty `policyXml` at the contract's own
 * policy file. Without this the copied policy would be inert: the template
 * ships `policyXml: ''`, which the Bicep template reads as "use the module
 * default" rather than "use the file sitting next to me".
 *
 * These values sit in a column-aligned block with trailing `//` comments. The
 * replacement is much longer than `''`, so the original padding can no longer
 * align anything; it is collapsed to a single space rather than left as a
 * ragged gap in the middle of the line.
 */
function wirePolicyReference(text, doc, policyName) {
  const splices = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'array') node.items.forEach(visit);
    else if (node.kind === 'object') {
      for (const prop of node.properties) {
        if (prop.key === 'policyXml' && prop.value.kind === 'string' && prop.value.value === '') {
          const pad = /^[ \t]+(?=\/\/)/.exec(text.slice(prop.value.end));
          splices.push({
            start: prop.value.start,
            end: prop.value.end + (pad ? pad[0].length : 0),
            text: `loadTextContent('${policyName}')${pad ? ' ' : ''}`,
          });
        } else {
          visit(prop.value);
        }
      }
    }
  };
  for (const p of doc.params) visit(p.value);
  return splices;
}

/**
 * Create a new contract folder from the fixed template pair.
 *
 * Both artefacts are copied, then two references are rewritten so the new
 * folder is self-consistent:
 *
 *   using          recomputed from the new folder's actual depth
 *   policyXml      pointed at the copied policy instead of left empty
 *
 * Everything else -- including all ~200 lines of inline guidance -- is carried
 * over byte-for-byte, because those comments are the documentation the user
 * edits against.
 */
export function createContract({ name, parent = CONTRACT_PARENT }) {
  const clean = String(name || '').trim().toLowerCase();
  if (!NAME_RULE.test(clean)) {
    throw Object.assign(
      new Error('Use lowercase letters, numbers and hyphens (slashes allowed for nesting).'),
      { status: 400 }
    );
  }

  const dirRel = toPosix(join(CONTRACT_ROOT, parent || '', clean));
  const targetDir = abs(dirRel);
  if (existsSync(targetDir)) {
    throw Object.assign(new Error(`Contract folder already exists: ${contractId(dirRel)}`), { status: 409 });
  }

  const templateParam = readFileSync(abs(TEMPLATE.paramFile), 'utf8');
  const templatePolicy = readFileSync(abs(TEMPLATE.policyFile), 'utf8');
  const doc = parseBicepParam(templateParam);

  const usingPath = toPosix(relative(targetDir, join(repoRoot, CONTRACT_ROOT, 'main.bicep')));
  const splices = wirePolicyReference(templateParam, doc, CONTRACT_POLICY_NAME);
  if (doc.using) splices.push({ start: doc.using.start, end: doc.using.end, text: `'${usingPath}'` });

  let paramText = templateParam;
  for (const s of splices.sort((a, b) => b.start - a.start)) {
    paramText = paramText.slice(0, s.start) + s.text + paramText.slice(s.end);
  }

  mkdirSync(targetDir, { recursive: true });
  const paramRel = toPosix(join(dirRel, 'main.bicepparam'));
  const policyRel = toPosix(join(dirRel, CONTRACT_POLICY_NAME));
  writeFileSync(abs(paramRel), paramText, 'utf8');
  writeFileSync(abs(policyRel), templatePolicy, 'utf8');
  snapshotContract(dirRel);

  return {
    id: contractId(dirRel),
    dir: dirRel,
    from: { param: TEMPLATE.paramFile, policy: TEMPLATE.policyFile },
    using: usingPath,
    created: [paramRel, policyRel],
  };
}

/**
 * Keep a recoverable copy of a contract.
 *
 * `contracts/` is git-ignored, so a contract has no version control behind it
 * and nothing to restore from if the folder is removed -- which has happened
 * repeatedly on this machine. The snapshot lives under CitadelUI, which is
 * tracked separately, and is refreshed on every create and every save so the
 * newest good state is always the one on offer.
 */
/** True for internal scratch paths (a dot-prefixed segment), never a user contract. */
function isScratchId(id) {
  return String(id)
    .split('/')
    .some((segment) => segment.startsWith('.'));
}

export function snapshotContract(dirRel) {
  const source = abs(dirRel);
  if (!existsSync(source)) return null;
  const id = contractId(dirRel);
  // The test suite creates and destroys contracts under `.scratch-contracts`.
  // Snapshotting those would leave orphans that the sheet then offers back as
  // if the user had lost real work.
  if (isScratchId(id)) return null;
  const target = join(repoRoot, SNAPSHOT_ROOT, id);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(source, entry.name), join(target, entry.name));
  }
  return target;
}

/** Snapshots whose contract folder is currently missing, so they can be offered back. */
export function orphanedSnapshots() {
  const root = join(repoRoot, SNAPSHOT_ROOT);
  if (!existsSync(root)) return [];
  const out = [];
  const scan = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const id = prefix ? `${prefix}/${entry.name}` : entry.name;
      const here = join(dir, entry.name);
      const files = readdirSync(here, { withFileTypes: true }).filter((f) => f.isFile());
      if (files.some((f) => f.name === 'main.bicepparam')) {
        // Ids are the same ones listContracts reports, so they resolve against
        // the contract root directly rather than through the parent folder.
        if (!existsSync(abs(join(CONTRACT_ROOT, id)))) {
          out.push({ id, files: files.map((f) => f.name), savedAt: statSync(here).mtimeMs });
        }
      } else {
        scan(here, id);
      }
    }
  };
  scan(root, '');
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Put a snapshot back where it came from. Never overwrites a live contract. */
export function restoreContract(id) {
  if (isScratchId(id)) {
    throw Object.assign(new Error(`${id} is an internal scratch path, not a contract.`), {
      status: 400,
    });
  }
  const source = join(repoRoot, SNAPSHOT_ROOT, id);
  if (!existsSync(source)) {
    throw Object.assign(new Error(`No snapshot for ${id}`), { status: 404 });
  }
  const dirRel = toPosix(join(CONTRACT_ROOT, id));
  const target = abs(dirRel);
  if (existsSync(target)) {
    throw Object.assign(new Error(`${id} already exists; nothing was overwritten.`), { status: 409 });
  }
  mkdirSync(target, { recursive: true });
  const restored = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(source, entry.name), join(target, entry.name));
    restored.push(toPosix(join(dirRel, entry.name)));
  }
  return { id, dir: dirRel, restored };
}
