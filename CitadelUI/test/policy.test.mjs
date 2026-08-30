/**
 * Policy control read/write.
 *
 * The guarantee under test is the same one the parameter editor makes: a write
 * changes only what it claims to and leaves every comment, every hand-written
 * rule and every byte of surrounding XML alone. Insertion is the new risk --
 * enabling a knob a policy does not carry has to land inside <inbound> without
 * disturbing what is already there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPolicyControls, applyPolicyChanges, POLICY_VARIABLES } from '../server/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const templatePath = join(
  repoRoot,
  'bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml'
);

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const xml = readFileSync(templatePath, 'utf8');
const controls = readPolicyControls(xml);

// --- reading ----------------------------------------------------------------

check('allowed models are read', controls.allowedModels.models, ['gpt-4.1', 'gpt-5.4-mini']);
check('token limit is enabled', controls.tokenLimit.enabled, true);
check('tokens-per-minute is read', controls.tokenLimit.attributes['tokens-per-minute'].value, '1000');
check('response headers are read', controls.responseHeaders.value, true);
check('every documented variable is reported', Object.keys(controls.variables).length, POLICY_VARIABLES.length);
check('a present variable is marked present', controls.variables.enableResponseHeaders.present, true);
check('an absent variable is marked absent', controls.variables.jwtRequired.present, false);
check('insertion point was found', typeof controls.insertAt === 'number', true);

// --- writing values in place ------------------------------------------------

{
  const out = applyPolicyChanges(xml, { allowedModels: 'gpt-4o,Phi-4' });
  check('allowed models are rewritten', readPolicyControls(out).allowedModels.models, ['gpt-4o', 'Phi-4']);
  check('rewrite preserves length of the rest', out.length - xml.length, 'gpt-4o,Phi-4'.length - 'gpt-4.1,gpt-5.4-mini'.length);
  check('comments survive a value rewrite', (out.match(/<!--/g) || []).length, (xml.match(/<!--/g) || []).length);
}

{
  const out = applyPolicyChanges(xml, {
    tokenLimit: { attributes: { 'counter-key': '@(context.Subscription.Id + "-" + context.Variables["requestedModel"])' } },
  });
  const rewritten = readPolicyControls(out).tokenLimit.attributes['counter-key'].value;
  check(
    'counter key scope is rewritten',
    rewritten,
    '@(context.Subscription.Id + &quot;-&quot; + context.Variables[&quot;requestedModel&quot;])'
  );
  check('other token attributes are untouched', readPolicyControls(out).tokenLimit.attributes['token-quota'].value, '100000');
}

// --- inserting an absent knob ----------------------------------------------

{
  const out = applyPolicyChanges(xml, { variables: { jwtRequired: true } });
  const after = readPolicyControls(out);
  check('absent knob becomes present', after.variables.jwtRequired.present, true);
  check('absent knob takes the given value', after.variables.jwtRequired.value, 'true');
  check('insertion keeps the policy well-formed', (out.match(/<\/policies>/g) || []).length, 1);
  check('insertion lands inside inbound', out.indexOf('jwtRequired') > out.indexOf('<inbound>') && out.indexOf('jwtRequired') < out.indexOf('</inbound>'), true);
  check('insertion leaves existing controls readable', after.allowedModels.models, ['gpt-4.1', 'gpt-5.4-mini']);
  check('insertion preserves every comment', (out.match(/<!--/g) || []).length, (xml.match(/<!--/g) || []).length);
}

{
  const out = applyPolicyChanges(xml, {
    variables: { jwtRequired: true, requiredRoles: 'Models.Read,Agent.Read' },
  });
  const after = readPolicyControls(out);
  check('two knobs insert together', [after.variables.jwtRequired.value, after.variables.requiredRoles.value], ['true', 'Models.Read,Agent.Read']);
}

{
  // Removing a knob deletes the declaration rather than leaving inert XML.
  const withJwt = applyPolicyChanges(xml, { variables: { jwtRequired: true } });
  const without = applyPolicyChanges(withJwt, { variables: { jwtRequired: null } });
  check('a knob can be removed again', readPolicyControls(without).variables.jwtRequired.present, false);
  check('removal restores the original text', without.replace(/\s+/g, ' ').trim(), xml.replace(/\s+/g, ' ').trim());
}

// --- rewriting an existing boolean knob ------------------------------------

{
  const out = applyPolicyChanges(xml, { variables: { enableResponseHeaders: false } });
  check('an existing boolean knob is rewritten in place', readPolicyControls(out).variables.enableResponseHeaders.value, 'false');
  check('rewriting in place does not duplicate the declaration', (out.match(/enableResponseHeaders/g) || []).length, (xml.match(/enableResponseHeaders/g) || []).length);
}

// --- blocks absent from this template --------------------------------------

check('content safety is absent from the template', controls.contentSafety, null);
check('rate limit is absent from the template', controls.rateLimit, null);
check('a change to an absent block is a no-op', applyPolicyChanges(xml, { contentSafety: { attributes: { 'shield-prompt': 'false' } } }), xml);

// --- a policy that does carry the extra blocks ------------------------------

const rich = xml.replace(
  '</inbound>',
  `    <llm-content-safety backend-id="content-safety-backend" shield-prompt="true" window-size="1000" window-overlap-size="200" enforce-on-completions="false">
            <categories output-type="EightSeverityLevels">
                <category name="Hate" threshold="3" />
                <category name="Violence" threshold="3" />
            </categories>
        </llm-content-safety>
        <rate-limit-by-key calls="60" renewal-period="60" counter-key="@(context.Subscription.Id + ":tool")" />
        <quota-by-key calls="100000" renewal-period="2592000" counter-key="@(context.Subscription.Id + ":tool")" />
    </inbound>`
);

{
  const rc = readPolicyControls(rich);
  check('content safety is read', rc.contentSafety.attributes['shield-prompt'].value, 'true');
  check('content safety categories are read', rc.contentSafety.categories.map((c) => `${c.name}:${c.threshold}`), ['Hate:3', 'Violence:3']);
  check('rate limit is read', rc.rateLimit.attributes.calls.value, '60');
  check('call quota is read', rc.callQuota.attributes.calls.value, '100000');

  const out = applyPolicyChanges(rich, {
    contentSafety: { attributes: { 'shield-prompt': 'false' }, categories: { Hate: '1' } },
    rateLimit: { attributes: { calls: '30' } },
    callQuota: { attributes: { 'renewal-period': '86400' } },
  });
  const oc = readPolicyControls(out);
  check('shield prompt is rewritten', oc.contentSafety.attributes['shield-prompt'].value, 'false');
  check('a category threshold is rewritten', oc.contentSafety.categories.find((c) => c.name === 'Hate').threshold, '1');
  check('the other category is untouched', oc.contentSafety.categories.find((c) => c.name === 'Violence').threshold, '3');
  check('rate limit calls are rewritten', oc.rateLimit.attributes.calls.value, '30');
  check('call quota period is rewritten', oc.callQuota.attributes['renewal-period'].value, '86400');
  check('call quota calls are untouched', oc.callQuota.attributes.calls.value, '100000');
}

// --- per-model token limits -------------------------------------------------

const COMMENTS = (t) => (t.match(/<!--/g) || []).length;

{
  const added = applyPolicyChanges(xml, { tokenLimits: { addModel: 'gpt-4o' } });
  const tl = readPolicyControls(added).tokenLimits;
  check('adding a per-model limit switches the shape', tl.mode, 'mixed');
  check('an added per-model limit reads back by name', tl.perModel.map((p) => p.model), ['gpt-4o']);
  check('the universal budget moves to the fallback', tl.universal.attributes['tokens-per-minute'].value, '1000');
  check('adding a per-model limit preserves every comment', COMMENTS(added), COMMENTS(xml));

  const removed = applyPolicyChanges(added, { tokenLimits: { removeModel: 'gpt-4o' } });
  check('removing the last per-model limit collapses the choose', readPolicyControls(removed).tokenLimits.mode, 'universal');
  check('the collapse restores the original text', removed, xml);

  const two = applyPolicyChanges(added, { tokenLimits: { addModel: 'gpt-4.1' } });
  check('a second model is appended in order', readPolicyControls(two).tokenLimits.perModel.map((p) => p.model), ['gpt-4o', 'gpt-4.1']);

  const one = applyPolicyChanges(two, { tokenLimits: { removeModel: 'gpt-4o' } });
  const oneTl = readPolicyControls(one).tokenLimits;
  check('removing a non-last model leaves the rest intact', oneTl.perModel.map((p) => p.model), ['gpt-4.1']);
  check('removing a non-last model keeps the choose', oneTl.mode, 'mixed');
  check('removal preserves every comment', COMMENTS(one), COMMENTS(xml));
}

{
  // The guide writes the condition with raw quotes; this editor writes it
  // XML-escaped. Both have to read back as the same model.
  const handWritten = xml.replace(
    /<llm-token-limit[\s\S]*?\/>/,
    `<choose>
            <when condition="@((string)context.Variables["requestedModel"] == "gpt-4o")">
                <llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="500" estimate-prompt-tokens="false" />
            </when>
            <otherwise>
                <llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="1000" estimate-prompt-tokens="false" />
            </otherwise>
        </choose>`
  );
  const tl = readPolicyControls(handWritten).tokenLimits;
  check('a hand-written raw-quote condition reads back by name', tl.perModel.map((p) => p.model), ['gpt-4o']);

  const edited = applyPolicyChanges(handWritten, {
    tokenLimits: { perModel: { 'gpt-4o': { 'tokens-per-minute': '250' } } },
  });
  check('a hand-written per-model limit can be edited', readPolicyControls(edited).tokenLimits.perModel[0].attributes['tokens-per-minute'].value, '250');

  const gone = applyPolicyChanges(handWritten, { tokenLimits: { removeModel: 'gpt-4o' } });
  check('a hand-written per-model limit can be removed', readPolicyControls(gone).tokenLimits.mode, 'universal');
}

{
  // A value edit aimed at a control created in the same payload used to be
  // dropped, because its span did not exist in the text being read.
  const out = applyPolicyChanges(xml, {
    tokenLimits: { addModel: 'gpt-4o', perModel: { 'gpt-4o': { 'tokens-per-minute': '250' } } },
  });
  const tl = readPolicyControls(out).tokenLimits;
  check('a freshly added model can be edited in the same write', tl.perModel[0].attributes['tokens-per-minute'].value, '250');
  check('editing the fallback does not touch the per-model branch', readPolicyControls(applyPolicyChanges(out, { tokenLimits: { universal: { 'tokens-per-minute': '9999' } } })).tokenLimits.perModel[0].attributes['tokens-per-minute'].value, '250');
  check('the fallback budget is addressable', readPolicyControls(applyPolicyChanges(out, { tokenLimits: { universal: { 'tokens-per-minute': '9999' } } })).tokenLimits.universal.attributes['tokens-per-minute'].value, '9999');
}

// --- enabling a block the template does not carry ---------------------------

{
  const out = applyPolicyChanges(xml, { contentSafety: { enable: true } });
  const cs = readPolicyControls(out).contentSafety;
  check('content safety can be enabled from nothing', cs.enabled, true);
  // window-size is configurable only for responses (requests are fixed at
  // 10,000 characters) and window-overlap-size defaults to no overlap, so an
  // inbound block does not assert either. All four documented categories are
  // scored, because one that is not listed is not checked at all.
  check('enabled content safety uses the documented defaults', [cs.attributes['backend-id'].value, cs.attributes['shield-prompt'].value, cs.attributes['enforce-on-completions'].value], ['content-safety-backend', 'true', 'false']);
  check('enabled content safety scores every category', cs.categories.map((c) => c.name), ['Hate', 'SelfHarm', 'Sexual', 'Violence']);
  check('enabled content safety uses eight severity levels', cs.outputType.value, 'EightSeverityLevels');
  check('enabling content safety lands inside inbound', out.indexOf('llm-content-safety') > out.indexOf('<inbound>') && out.indexOf('llm-content-safety') < out.indexOf('</inbound>'), true);
  check('enabling content safety preserves every comment', COMMENTS(out), COMMENTS(xml));

  const off = applyPolicyChanges(applyPolicyChanges(out, { contentSafety: { categories: { Hate: '1' } } }), { contentSafety: { enabled: false } });
  const offCs = readPolicyControls(off).contentSafety;
  check('content safety can be disabled', offCs.enabled, false);
  check('disabling content safety keeps the configured numbers', offCs.categories.find((c) => c.name === 'Hate').threshold, '1');
  check('disabling content safety preserves the original comments', COMMENTS(off), COMMENTS(xml) + 1);
  check('content safety comes back on unchanged', applyPolicyChanges(off, { contentSafety: { enabled: true } }), applyPolicyChanges(out, { contentSafety: { categories: { Hate: '1' } } }));
}

{
  const enabled = applyPolicyChanges(xml, { contentSafety: { enable: true } });
  // The default block already scores all four, so adding is exercised from a
  // policy that is deliberately missing one.
  const trimmed = applyPolicyChanges(enabled, { contentSafety: { removeCategory: 'SelfHarm' } });
  const added = applyPolicyChanges(trimmed, { contentSafety: { addCategory: 'SelfHarm' } });
  check('a category can be added', readPolicyControls(added).contentSafety.categories.map((c) => c.name), ['Hate', 'Sexual', 'Violence', 'SelfHarm']);
  check('adding a category preserves every comment', COMMENTS(added), COMMENTS(xml));

  const removed = applyPolicyChanges(added, { contentSafety: { removeCategory: 'Violence' } });
  check('a category can be removed', readPolicyControls(removed).contentSafety.categories.map((c) => c.name), ['Hate', 'Sexual', 'SelfHarm']);
  check('removing a category preserves every comment', COMMENTS(removed), COMMENTS(xml));

  check('an undocumented category is refused', readPolicyControls(applyPolicyChanges(enabled, { contentSafety: { addCategory: 'Profanity' } })).contentSafety.categories.map((c) => c.name), ['Hate', 'SelfHarm', 'Sexual', 'Violence']);

  const chained = applyPolicyChanges(xml, { contentSafety: { enable: true, categories: { Hate: '0' } } });
  check('enable and edit compose in one write', readPolicyControls(chained).contentSafety.categories.map((c) => `${c.name}:${c.threshold}`), ['Hate:0', 'SelfHarm:4', 'Sexual:4', 'Violence:4']);
}

{
  const out = applyPolicyChanges(xml, { rateLimit: { enable: true }, callQuota: { enable: true } });
  const rc = readPolicyControls(out);
  check('the request rate limit can be enabled from nothing', [rc.rateLimit.attributes.calls.value, rc.rateLimit.attributes['renewal-period'].value], ['60', '60']);
  check('the call quota can be enabled from nothing', [rc.callQuota.attributes.calls.value, rc.callQuota.attributes['renewal-period'].value], ['100000', '2592000']);
  check('both throttles count per subscription', [rc.rateLimit.attributes['counter-key'].value.includes('context.Subscription.Id'), rc.callQuota.attributes['counter-key'].value.includes('context.Subscription.Id')], [true, true]);
  check('enabling the throttles lands inside inbound', out.indexOf('rate-limit-by-key') > out.indexOf('<inbound>') && out.indexOf('quota-by-key') < out.indexOf('</inbound>'), true);
  check('enabling the throttles preserves every comment', COMMENTS(out), COMMENTS(xml));

  const tuned = applyPolicyChanges(out, { rateLimit: { attributes: { calls: '120' }, enabled: false }, callQuota: { enabled: false } });
  const tc = readPolicyControls(tuned);
  check('the rate limit can be disabled', tc.rateLimit.enabled, false);
  check('disabling the rate limit keeps the configured calls', tc.rateLimit.attributes.calls.value, '120');
  check('the call quota can be disabled', tc.callQuota.enabled, false);
  check('disabling the throttles preserves the original comments', COMMENTS(tuned), COMMENTS(xml) + 2);
  check('the rate limit comes back on', readPolicyControls(applyPolicyChanges(tuned, { rateLimit: { enabled: true } })).rateLimit.enabled, true);
}

{
  // A block carrying its own comment cannot be wrapped in one, so the toggle
  // has to decline rather than emit nested comments.
  const commented = xml.replace(
    '</inbound>',
    `    <llm-content-safety backend-id="content-safety-backend" shield-prompt="true">
            <categories output-type="EightSeverityLevels">
                <!-- 0 is most restrictive -->
                <category name="Hate" threshold="3" />
            </categories>
        </llm-content-safety>
    </inbound>`
  );
  check('a block with an inner comment reports it', readPolicyControls(commented).contentSafety.hasInnerComment, true);
  check('disabling a block with an inner comment is refused', applyPolicyChanges(commented, { contentSafety: { enabled: false } }), commented);
}

// --- per-model call limits --------------------------------------------------
// rate-limit-by-key and quota-by-key drive the same <choose> on requestedModel
// that token limits do, so per-model support must exist for all three or the
// screen promises something the writer cannot deliver.

{
  const withRate = applyPolicyChanges(xml, { rateLimit: { enable: true } });
  const rc = readPolicyControls(withRate);
  check('rate limit reads as a structure', rc.rateLimits.mode, 'universal');
  check('rate limit structure carries its tag', rc.rateLimits.tag, 'rate-limit-by-key');

  const mixed = applyPolicyChanges(withRate, { rateLimits: { addModel: 'gpt-4o' } });
  const mc = readPolicyControls(mixed);
  check('call limit becomes mixed', mc.rateLimits.mode, 'mixed');
  check('call limit names the model', mc.rateLimits.perModel.map((p) => p.model), ['gpt-4o']);
  check('call branch keeps the call attribute', Boolean(mc.rateLimits.perModel[0].attributes.calls), true);
  check(
    'call branch meters per model',
    mc.rateLimits.perModel[0].attributes['counter-key'].value.includes('requestedModel'),
    true
  );
  check('token limits are unaffected', mc.tokenLimits.mode, 'universal');
  check('comments survive the conversion', (mixed.match(/<!--/g) || []).length, (xml.match(/<!--/g) || []).length);

  const edited = applyPolicyChanges(mixed, { rateLimits: { perModel: { 'gpt-4o': { calls: '5' } } } });
  check('a per-model call value is rewritten', readPolicyControls(edited).rateLimits.perModel[0].attributes.calls.value, '5');

  const back = applyPolicyChanges(mixed, { rateLimits: { removeModel: 'gpt-4o' } });
  const bc = readPolicyControls(back);
  check('removing the last call branch collapses the choose', bc.rateLimits.mode, 'universal');
  check('collapse restores the call element', bc.rateLimits.tag, 'rate-limit-by-key');
}

{
  // Two <choose> blocks in one policy must not be confused for each other.
  const both = applyPolicyChanges(
    applyPolicyChanges(xml, { rateLimit: { enable: true } }),
    { tokenLimits: { addModel: 'gpt-4o' }, rateLimits: { addModel: 'Phi-4' } }
  );
  const c = readPolicyControls(both);
  check('token choose is matched by its own element', c.tokenLimits.perModel.map((p) => p.model), ['gpt-4o']);
  check('call choose is matched by its own element', c.rateLimits.perModel.map((p) => p.model), ['Phi-4']);
}
// --- content safety: output type and blocklists ------------------------------
// Both are documented parts of llm-content-safety that the editor previously
// could not see, so a policy using them looked simpler than it was.

{
  const enabled = applyPolicyChanges(xml, { contentSafety: { enable: true } });
  const cs = readPolicyControls(enabled).contentSafety;
  check('output type is read', cs.outputType.value, 'EightSeverityLevels');
  check('a policy with no blocklists reports none', cs.blocklists, []);
  check('the blocklist insertion point follows the categories', typeof cs.blocklistInsertAt, 'number');

  const withLists = enabled.replace(
    '</categories>',
    '</categories>\r\n            <blocklists>\r\n                <id>banned-terms</id>\r\n                <id>competitors</id>\r\n            </blocklists>'
  );
  const lc = readPolicyControls(withLists).contentSafety;
  check('blocklist ids are read', lc.blocklists.map((b) => b.id), ['banned-terms', 'competitors']);
  check('every blocklist id carries a span', lc.blocklists.every((b) => b.span.end > b.span.start), true);
  check(
    'a blocklist id maps to its own text',
    withLists.slice(lc.blocklists[1].span.start, lc.blocklists[1].span.end),
    'competitors'
  );
}

// --- semantic caching --------------------------------------------------------

{
  check('a policy without caching reports none', readPolicyControls(xml).semanticCache, null);

  const cached = applyPolicyChanges(xml, { semanticCache: { enable: true } });
  const sc = readPolicyControls(cached).semanticCache;
  check('lookup is read', Boolean(sc.lookup), true);
  check('score threshold is read', sc.lookup.attributes['score-threshold'].value, '0.05');
  check('embeddings auth is the only permitted value', sc.lookup.attributes['embeddings-backend-auth'].value, 'system-assigned');
  check('vary-by is read', sc.lookup.varyBy.map((v) => v.value), ['@(context.Subscription.Id)']);
  check('enabling caching preserves every comment', COMMENTS(cached), COMMENTS(xml));
  check('lookup lands in inbound', cached.indexOf('semantic-cache-lookup') > cached.indexOf('<inbound>') && cached.indexOf('semantic-cache-lookup') < cached.indexOf('</inbound>'), true);
}
// --- semantic cache writes ---------------------------------------------------

{
  const cached = applyPolicyChanges(xml, { semanticCache: { enable: true } });
  const tuned = applyPolicyChanges(cached, {
    semanticCache: { lookup: { 'score-threshold': '0.12', 'ignore-system-messages': 'false' } },
  });
  const sc = readPolicyControls(tuned).semanticCache;
  check('score threshold is rewritten', sc.lookup.attributes['score-threshold'].value, '0.12');
  check('a lookup boolean is rewritten', sc.lookup.attributes['ignore-system-messages'].value, 'false');
  check('the embeddings backend is untouched', sc.lookup.attributes['embeddings-backend-id'].value, 'embeddings-backend');

  const partitioned = applyPolicyChanges(cached, { semanticCache: { varyBy: { 0: '@(context.Request.IpAddress)' } } });
  check(
    'a cache partition is rewritten',
    readPolicyControls(partitioned).semanticCache.lookup.varyBy[0].value,
    '@(context.Request.IpAddress)'
  );
  check('tuning the cache preserves every comment', COMMENTS(tuned), COMMENTS(xml));
}
// --- escaping ----------------------------------------------------------------
// Counter keys contain quoted string literals, so a value that survives a
// wrap/unwrap cycle must come back byte-identical rather than gaining a layer
// of entity encoding each time.

{
  const mixed = applyPolicyChanges(xml, { tokenLimits: { addModel: 'gpt-4o' } });
  const fallback = readPolicyControls(mixed).tokenLimits.universal.attributes['counter-key'].value;
  check('the fallback counter key is not double-escaped', fallback.includes('&amp;quot;'), false);
  check('the fallback counter key is unchanged', fallback, '@(context.Subscription.Id)');

  const withRate = applyPolicyChanges(xml, { rateLimit: { enable: true } });
  const rateMixed = applyPolicyChanges(withRate, { rateLimits: { addModel: 'gpt-4o' } });
  const rateFallback = readPolicyControls(rateMixed).rateLimits.universal.attributes['counter-key'].value;
  check('a quoted counter key survives the wrap', rateFallback, '@(context.Subscription.Id + &quot;:tool&quot;)');
  check('a quoted counter key is not double-escaped', rateFallback.includes('&amp;'), false);

  const back = applyPolicyChanges(rateMixed, { rateLimits: { removeModel: 'gpt-4o' } });
  check(
    'a quoted counter key survives the unwrap',
    readPolicyControls(back).rateLimits.universal.attributes['counter-key'].value,
    '@(context.Subscription.Id + &quot;:tool&quot;)'
  );
}
// --- content safety: output type and blocklist writes ------------------------

{
  const enabled = applyPolicyChanges(xml, { contentSafety: { enable: true } });

  const four = applyPolicyChanges(enabled, { contentSafety: { outputType: 'FourSeverityLevels' } });
  check('output type is rewritten', readPolicyControls(four).contentSafety.outputType.value, 'FourSeverityLevels');
  check('changing output type keeps every category', readPolicyControls(four).contentSafety.categories.length, 4);

  const listed = applyPolicyChanges(enabled, { contentSafety: { addBlocklist: 'banned-terms' } });
  const lc = readPolicyControls(listed).contentSafety;
  check('a blocklist can be added to a policy with none', lc.blocklists.map((b) => b.id), ['banned-terms']);
  check('adding a blocklist preserves every comment', COMMENTS(listed), COMMENTS(xml));
  check('the blocklists element follows the categories', listed.indexOf('<blocklists>') > listed.indexOf('</categories>'), true);

  const two = applyPolicyChanges(listed, { contentSafety: { addBlocklist: 'competitors' } });
  check('a second blocklist joins the existing element', readPolicyControls(two).contentSafety.blocklists.map((b) => b.id), ['banned-terms', 'competitors']);
  check('a second blocklist does not duplicate the wrapper', (two.match(/<blocklists>/g) || []).length, 1);

  const oneLeft = applyPolicyChanges(two, { contentSafety: { removeBlocklist: 'banned-terms' } });
  check('one blocklist can be removed', readPolicyControls(oneLeft).contentSafety.blocklists.map((b) => b.id), ['competitors']);

  const none = applyPolicyChanges(listed, { contentSafety: { removeBlocklist: 'banned-terms' } });
  check('removing the last blocklist drops the wrapper', (none.match(/<blocklists>/g) || []).length, 0);
  check('dropping the wrapper leaves the policy readable', readPolicyControls(none).contentSafety.categories.length, 4);
  check('dropping the wrapper preserves every comment', COMMENTS(none), COMMENTS(xml));
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
