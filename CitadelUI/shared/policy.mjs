/** Pure APIM policy parser/editor shared by browser and isolated Node tests. */

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
 * Find a self-closing XML element without treating `>` or `/>` inside a quoted
 * attribute value as markup.
 *
 * APIM policy expressions routinely contain comparison operators and quoted
 * strings. A `[^>]*` opening-tag regex therefore stops in the middle of a valid
 * value such as `@(context.Response.StatusCode >= 400)`.
 */
function findSelfClosingElement(xml, tag, from = 0, to = xml.length) {
  const opener = new RegExp(`<${tag}\\b`, 'g');
  opener.lastIndex = from;
  let match;
  while ((match = opener.exec(xml)) && match.index < to) {
    let quote = null;
    let end = null;
    for (let index = match.index + match[0].length; index < to; index += 1) {
      const char = xml[index];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end = index + 1;
        break;
      }
    }
    if (end === null) return null;
    if (/\/\s*>$/.test(xml.slice(match.index, end))) {
      return { start: match.index, end, text: xml.slice(match.index, end) };
    }
    opener.lastIndex = end;
  }
  return null;
}

/** Read quoted attributes and retain exact value spans in the source XML. */
function readAttributes(xml, start, end) {
  const body = xml.slice(start, end);
  const attributes = {};
  const attrRe = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRe.exec(body))) {
    const value = match[2] ?? match[3];
    const quote = match[2] === undefined ? "'" : '"';
    const valueStart = start + match.index + match[0].indexOf(quote) + 1;
    attributes[match[1]] = {
      value,
      span: { start: valueStart, end: valueStart + value.length },
    };
  }
  return attributes;
}

/**
 * The line ending the file already uses.
 *
 * Inserted markup has to match it. The repository is CRLF, and splicing bare
 * LF into it leaves a file with mixed endings that appears as a whole-file
 * change even though only one line was added.
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
  const element = findSelfClosingElement(xml, tag);
  if (!element) return null;
  const leadingComment = /<!--\s*$/.exec(xml.slice(0, element.start));
  const trailingComment = leadingComment ? /^\s*-->/.exec(xml.slice(element.end)) : null;
  const spanStart = leadingComment ? leadingComment.index : element.start;
  const spanEnd = trailingComment ? element.end + trailingComment[0].length : element.end;
  return {
    enabled: !leadingComment,
    attributes: readAttributes(xml, element.start, element.end),
    span: { start: spanStart, end: spanEnd },
    bodySpan: { start: element.start, end: element.end },
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
      tag,
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
  return {
    attributes: readAttributes(xml, elementStart, elementEnd),
    commented,
    span: { start: elementStart, end: elementEnd },
  };
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
  let choose = null;
  let c;
  while ((c = chooseRe.exec(xml))) {
    if (findSelfClosingElement(c[0], tag)) {
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
      const limit = findSelfClosingElement(w[2], tag);
      if (!limit) continue;
      const start = choose.index + w.index + w[0].indexOf(w[2]) + limit.start;
      perModel.push({
        model: modelFromCondition(w[1]),
        condition: w[1],
        ...readLimitElement(xml, start, start + limit.text.length, false),
        whenSpan: { start: choose.index + w.index, end: choose.index + w.index + w[0].length },
      });
    }

    const other = /<otherwise>([\s\S]*?)<\/otherwise>/.exec(block);
    if (other) {
      const limit = findSelfClosingElement(other[1], tag);
      if (limit) {
        const start = choose.index + other.index + other[0].indexOf(other[1]) + limit.start;
        universal = {
          ...readLimitElement(xml, start, start + limit.text.length, false),
          inOtherwise: true,
          otherwiseSpan: { start: choose.index + other.index, end: choose.index + other.index + other[0].length },
        };
      }
    }
    return { tag, mode: universal ? 'mixed' : 'per-model', universal, perModel, chooseSpan };
  }

  const bare = findSelfClosingElement(xml, tag);
  if (bare) {
    const leadingComment = /<!--\s*$/.exec(xml.slice(0, bare.start));
    const trailingComment = leadingComment ? /^\s*-->/.exec(xml.slice(bare.end)) : null;
    const wrapperStart = leadingComment ? leadingComment.index : bare.start;
    const wrapperEnd = trailingComment ? bare.end + trailingComment[0].length : bare.end;
    universal = {
      ...readLimitElement(xml, bare.start, bare.end, Boolean(leadingComment)),
      inOtherwise: false,
      wrapperSpan: { start: wrapperStart, end: wrapperEnd },
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
 * Rewrite present attributes and append absent attributes to an element's
 * opening tag. Missing attributes share one insertion to avoid overlapping
 * zero-width splices when a complete guided form is saved at once.
 */
function attributeSplices(xml, element, values) {
  if (!element || !values) return [];
  const splices = [];
  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    const attribute = element.attributes[key];
    if (attribute) splices.push({ ...attribute.span, text: escapeAttr(String(value)) });
    else missing.push([key, value]);
  }
  if (!missing.length) return splices;

  const start = element.bodySpan?.start ?? element.span.start;
  const end = element.bodySpan?.end ?? element.span.end;
  let quote = null;
  let close = null;
  for (let index = start; index < end; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      close = xml[index - 1] === '/' ? index - 1 : index;
      break;
    }
  }
  if (close !== null) {
    splices.push({
      start: close,
      end: close,
      text: missing.map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`).join(''),
    });
  }
  return splices;
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
  return [...new Set(values.flat().filter((v) => v !== undefined && v !== null && v !== ''))];
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
  if (name === 'semanticCacheStore') {
    return `${eol}${i}<llm-semantic-cache-store duration="3600" />`;
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

  for (const name of ['contentSafety', 'rateLimit', 'callQuota']) {
    const change = changes[name];
    if (!change || !change.enable || controls[name] || controls.insertAt === null) continue;
    splices.push({ start: controls.insertAt, end: controls.insertAt, text: defaultBlock(name, eol) });
  }

  const semantic = changes.semanticCache;
  if (semantic?.enable) {
    if (!controls.semanticCache?.lookup && controls.insertAt !== null) {
      splices.push({
        start: controls.insertAt,
        end: controls.insertAt,
        text: defaultBlock('semanticCache', eol),
      });
    }
    if (!controls.semanticCache?.store) {
      const outboundAt = sectionInsertAt(xml, 'outbound');
      if (outboundAt !== null) {
        splices.push({
          start: outboundAt,
          end: outboundAt,
          text: defaultBlock('semanticCacheStore', eol),
        });
      }
    }
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
      // Adding the first branch replaces a bare element with a choose. Re-read
      // that new shape before adding another branch so replacement spans never
      // overlap.
      break;
    }
  }

  return spliceAll(xml, splices);
}

/** Find the live insertion point immediately after a pipeline section's base. */
function sectionInsertAt(xml, name) {
  const comments = commentRanges(xml);
  const re = new RegExp(`<${name}>[ \\t]*\\r?\\n?(\\s*<base\\s*\\/>)?`, 'g');
  let match;
  while ((match = re.exec(xml))) {
    if (!inRanges(comments, match.index)) return match.index + match[0].length;
  }
  return null;
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
function removeControlItems(xml, changes) {
  const controls = readPolicyControls(xml);
  const splices = [];

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
  }

  const sc = changes.semanticCache;
  const lookup = controls.semanticCache?.lookup;
  if (sc && lookup) {
    for (const expression of asList(sc.removeVaryBy, sc.removeVaryBys || [])) {
      const entry = lookup.varyBy.find((v) => v.value === expression);
      if (entry && lookup.varyBy.length > 1) {
        splices.push({ ...lineSpan(xml, entry.elementSpan), text: '' });
      }
    }
  }

  const content = changes.contentSafety;
  const safety = controls.contentSafety;
  if (content && safety) {
    for (const name of asList(content.removeCategory, content.removeCategories || [])) {
      const category = safety.categories.find((candidate) => candidate.name === name);
      if (category) splices.push({ ...lineSpan(xml, category.elementSpan), text: '' });
    }
    for (const id of asList(content.removeBlocklist, content.removeBlocklists || [])) {
      const entry = safety.blocklists.find((candidate) => candidate.id === id);
      if (!entry) continue;
      const last = safety.blocklists.length === 1 && safety.blocklistBlock;
      splices.push({
        ...lineSpan(xml, last ? safety.blocklistBlock : entry.elementSpan),
        text: '',
      });
    }
  }

  if (changes.variables) {
    for (const [key, next] of Object.entries(changes.variables)) {
      const found = controls.variables?.[key];
      if (next === null && found?.present && !found.commented) {
        splices.push({ ...lineSpan(xml, found.elementSpan), text: '' });
      }
    }
  }

  return spliceAll(xml, splices);
}

function writeControlValues(xml, changes) {
  const controls = readPolicyControls(xml);
  const splices = [];
  const eol = eolOf(xml);

  if (changes.allowedModels !== undefined && controls.allowedModels) {
    splices.push({ ...controls.allowedModels.span, text: escapeAttr(changes.allowedModels) });
  }

  if (changes.responseHeaders !== undefined && controls.responseHeaders) {
    splices.push({ ...controls.responseHeaders.span, text: changes.responseHeaders ? 'true' : 'false' });
  }

  if (changes.variables) {
    for (const [key, next] of Object.entries(changes.variables)) {
      const def = VARIABLE_BY_KEY.get(key);
      const found = controls.variables?.[key];
      if (!def || next === null || !found?.present || found.commented) continue;
      if (key === 'enableResponseHeaders' && changes.responseHeaders !== undefined) continue;
      splices.push({
        ...found.span,
        text: def.type === 'boolean' ? (next ? 'true' : 'false') : escapeAttr(String(next)),
      });
    }
  }

  for (const [key, flatKey, structure] of [
    ['tokenLimits', 'tokenLimit', controls.tokenLimits],
    ['rateLimits', 'rateLimit', controls.rateLimits],
    ['quotaLimits', 'callQuota', controls.quotaLimits],
  ]) {
    const limits = changes[key] || {};
    const flat = changes[flatKey]?.attributes || {};
    if (!structure || (!changes[key] && !Object.keys(flat).length)) continue;

    for (const [model, attributes] of Object.entries(limits.perModel || {})) {
      const entry = structure.perModel.find((p) => p.model === model);
      if (!entry) continue;
      splices.push(...attributeSplices(xml, entry, attributes));
    }

    // Once a choose exists, the legacy flat reader points at its first branch.
    // Treat flat edits as fallback edits and let explicit structural values win.
    splices.push(
      ...attributeSplices(xml, structure.universal, {
        ...flat,
        ...(limits.universal || {}),
      })
    );
  }

  const sc = changes.semanticCache;
  if (sc && controls.semanticCache) {
    splices.push(...attributeSplices(xml, controls.semanticCache.lookup, sc.lookup));
    splices.push(...attributeSplices(xml, controls.semanticCache.store, sc.store));

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
    }
  }

  for (const name of ['contentSafety']) {
    const control = controls[name];
    const change = changes[name];
    if (!change || !control) continue;
    splices.push(...attributeSplices(xml, control, change.attributes));
    for (const [catName, threshold] of Object.entries(change.categories || {})) {
      const cat = (control.categories || []).find((c) => c.name === catName);
      if (cat) splices.push({ ...cat.span, text: escapeAttr(String(threshold)) });
    }

    if (name === 'contentSafety') {
      if (change.outputType && control.outputType && control.outputType.span) {
        splices.push({ ...control.outputType.span, text: escapeAttr(String(change.outputType)) });
      }
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
    return targets.map((entry) => {
      const comments = [
        ...xml.slice(entry.whenSpan.start, entry.whenSpan.end).matchAll(/<!--[\s\S]*?-->/g),
      ].map((match) => match[0]);
      const indent = /[ \t]*$/.exec(xml.slice(0, entry.whenSpan.start))[0];
      return {
        ...lineSpan(xml, entry.whenSpan),
        text: comments.length ? `${comments.join(`${eolOf(xml)}${indent}`)}${eolOf(xml)}` : '',
      };
    });
  }

  if (tl.universal && tl.universal.inOtherwise) {
    // Nothing model-specific is left, so collapse back to a bare limit.
    const comments = [...block.matchAll(/<!--[\s\S]*?-->/g)].map((match) => match[0]);
    const indent = /[ \t]*$/.exec(xml.slice(0, tl.chooseSpan.start))[0];
    const element = xml.slice(tl.universal.span.start, tl.universal.span.end);
    return [
      {
        start: tl.chooseSpan.start,
        end: tl.chooseSpan.end,
        text: comments.length
          ? `${comments.join(`${eolOf(xml)}${indent}`)}${eolOf(xml)}${indent}${element}`
          : element,
      },
    ];
  }
  // A <choose> with no branches left would be dead markup.
  const comments = [...block.matchAll(/<!--[\s\S]*?-->/g)].map((match) => match[0]);
  const indent = /[ \t]*$/.exec(xml.slice(0, tl.chooseSpan.start))[0];
  return [{
    ...lineSpan(xml, tl.chooseSpan),
    text: comments.length ? `${comments.join(`${eolOf(xml)}${indent}`)}${eolOf(xml)}` : '',
  }];
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

  const semantic = changes.semanticCache;
  if (semantic?.enabled !== undefined && controls.semanticCache) {
    const parts = [
      controls.semanticCache.lookup,
      controls.semanticCache.store,
    ].filter(Boolean);
    // Disabling must remain paired. If either half cannot be wrapped without
    // nesting XML comments, leave both live rather than disabling only one.
    if (semantic.enabled || !parts.some((control) => control.hasInnerComment)) {
      for (const control of parts) {
        if (semantic.enabled === control.enabled) continue;
        const body = xml.slice(control.bodySpan.start, control.bodySpan.end);
        splices.push({
          start: control.span.start,
          end: control.span.end,
          text: semantic.enabled ? body : `<!-- ${body} -->`,
        });
      }
    }
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
  for (let pass = 0; pass < 50; pass += 1) {
    const next = insertMissingControls(out, changes);
    if (next === out) break;
    out = next;
  }
  out = removeControlItems(out, changes);
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

export function assertBalancedXml(text) {
  const stripped = String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const stack = [];
  const tagPattern = /<(\/?)([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(stripped))) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        throw new Error(
          open
            ? `Malformed XML: </${name}> closes <${open}>.`
            : `Malformed XML: </${name}> has no opening tag.`
        );
      }
    } else {
      stack.push(name);
    }
  }
  if (stack.length) throw new Error(`Malformed XML: <${stack.at(-1)}> is never closed.`);
}
