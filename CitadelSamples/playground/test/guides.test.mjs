/**
 * Guide, prerequisite, schema and expected-result completeness.
 *
 * The brief requires every recipe to carry purpose, detailed explanation, a
 * numbered flow, prerequisites with acquisition guidance and authoritative
 * links, a typed schema, validation, risk, a source citation and expected
 * assertions. This file checks each of those for all 19.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, SAMPLES, profilesFor } from '../src/catalogue/index.mjs';
import { FIELD_CLASSIFICATIONS, FIELD_TYPES } from '../src/core/types.mjs';
import { LINKS } from '../src/catalogue/profiles.mjs';

const AUTHORITATIVE_HOSTS = ['learn.microsoft.com', 'github.com', 'modelcontextprotocol.io'];

function allLinks() {
  const links = [];
  for (const entry of Object.values(LINKS)) links.push(entry);
  for (const profile of CATALOGUE.profiles) {
    for (const field of profile.fields) links.push(...(field.links ?? []));
  }
  for (const sample of SAMPLES) {
    for (const prerequisite of sample.prerequisites ?? []) links.push(...(prerequisite.links ?? []));
    for (const field of sample.fields) links.push(...(field.links ?? []));
  }
  return links;
}

test('every recipe has a title, summary and purpose', () => {
  for (const sample of SAMPLES) {
    assert.ok(sample.title?.length > 3, `${sample.id} has no title`);
    assert.ok(sample.shortTitle?.length > 2, `${sample.id} has no short title`);
    assert.ok(sample.summary?.length > 30, `${sample.id} has a thin summary`);
    assert.ok(sample.purpose?.length > 120, `${sample.id} has a thin purpose`);
  }
});

test('every recipe has a detailed multi-paragraph explanation', () => {
  for (const sample of SAMPLES) {
    assert.ok(Array.isArray(sample.explanation), `${sample.id} has no explanation`);
    assert.ok(sample.explanation.length >= 3, `${sample.id} explanation has ${sample.explanation.length} paragraphs`);
    for (const paragraph of sample.explanation) {
      assert.ok(paragraph.length > 80, `${sample.id} has a stub explanation paragraph`);
    }
  }
});

test('every recipe has a numbered flow of at least three steps', () => {
  for (const sample of SAMPLES) {
    assert.ok(Array.isArray(sample.flow), `${sample.id} has no flow`);
    assert.ok(sample.flow.length >= 3, `${sample.id} flow has only ${sample.flow.length} steps`);
    for (const entry of sample.flow) assert.ok(entry.length > 15, `${sample.id} has a stub flow step`);
  }
});

test('every recipe has prerequisites with detail, how-to and links', () => {
  for (const sample of SAMPLES) {
    assert.ok(Array.isArray(sample.prerequisites), `${sample.id} has no prerequisites array`);
    assert.ok(sample.prerequisites.length >= 2, `${sample.id} declares ${sample.prerequisites.length} prerequisites`);
    const ids = sample.prerequisites.map((prerequisite) => prerequisite.id);
    assert.equal(new Set(ids).size, ids.length, `${sample.id} has duplicate prerequisite ids`);
    for (const prerequisite of sample.prerequisites) {
      assert.ok(prerequisite.title?.length > 5, `${sample.id}/${prerequisite.id} has no title`);
      assert.ok(prerequisite.detail?.length > 40, `${sample.id}/${prerequisite.id} has a thin detail`);
      assert.ok(prerequisite.howTo?.length > 20, `${sample.id}/${prerequisite.id} has no how-to`);
      assert.ok(prerequisite.links?.length >= 1, `${sample.id}/${prerequisite.id} has no link`);
    }
  }
});

test('every recipe field is a typed, classified, documented schema entry', () => {
  for (const sample of SAMPLES) {
    const names = sample.fields.map((field) => field.name);
    assert.equal(new Set(names).size, names.length, `${sample.id} has duplicate field names`);
    for (const field of sample.fields) {
      assert.ok(FIELD_TYPES.includes(field.type), `${sample.id}.${field.name} has type ${field.type}`);
      assert.ok(
        FIELD_CLASSIFICATIONS.includes(field.classification),
        `${sample.id}.${field.name} has classification ${field.classification}`,
      );
      assert.ok(field.label, `${sample.id}.${field.name} has no label`);
      assert.ok(field.help?.length > 25, `${sample.id}.${field.name} has thin help`);
      assert.ok(field.howToObtain?.length > 15, `${sample.id}.${field.name} has no acquisition guidance`);
      assert.ok(field.notebookRef, `${sample.id}.${field.name} has no notebook reference`);
      assert.ok(field.links?.length >= 1, `${sample.id}.${field.name} has no link`);
      assert.equal(field.path, `samples.${sample.id}.${field.name}`);
      if (field.classification === 'derived') {
        assert.ok(field.derivedFrom, `${sample.id}.${field.name} is derived but does not say from what`);
      }
      if (field.type === 'enum') {
        assert.ok(field.options?.length >= 1, `${sample.id}.${field.name} is an enum with no options`);
      }
      if (field.type === 'integer') {
        assert.equal(typeof field.default, 'number', `${sample.id}.${field.name} integer default must be a number`);
      }
    }
  }
});

test('every recipe declares a builder and it is a function', () => {
  for (const sample of SAMPLES) {
    assert.equal(typeof sample.build, 'function', `${sample.id} has no builder`);
  }
});

test('every recipe declares expected results with assertion, evidence and a not-run meaning', () => {
  for (const sample of SAMPLES) {
    assert.ok(Array.isArray(sample.expectedResults), `${sample.id} has no expected results`);
    assert.ok(sample.expectedResults.length >= 2, `${sample.id} has ${sample.expectedResults.length} expected results`);
    const ids = sample.expectedResults.map((expected) => expected.id);
    assert.equal(new Set(ids).size, ids.length, `${sample.id} has duplicate expected-result ids`);
    for (const expected of sample.expectedResults) {
      assert.ok(expected.title?.length > 5, `${sample.id}/${expected.id} has no title`);
      assert.ok(expected.assertion?.length > 30, `${sample.id}/${expected.id} has a thin assertion`);
      assert.ok(expected.evidence?.length > 5, `${sample.id}/${expected.id} names no evidence`);
      assert.ok(expected.whenNotRun?.length > 5, `${sample.id}/${expected.id} does not say what "not run" means`);
    }
  }
});

test('every recipe records its source note and any deviation from the notebook', () => {
  for (const sample of SAMPLES) {
    assert.ok(sample.sourceNote?.length > 40, `${sample.id} has no source note`);
    assert.ok(Array.isArray(sample.deviations), `${sample.id} has no deviations array`);
    assert.ok(Array.isArray(sample.notes), `${sample.id} has no notes array`);
    for (const deviation of sample.deviations) {
      assert.ok(deviation.length > 50, `${sample.id} has a stub deviation`);
    }
  }
});

test('the recipes that correct a notebook weakness say so', () => {
  const byId = new Map(SAMPLES.map((sample) => [sample.id, sample]));
  const requiredDisclosures = [
    ['a2a-message-send', /JSON-RPC error inside an HTTP 200|status code alone/i],
    ['access-contract-kv-verify', /excludes it from|endpoint secrets alone/i],
    ['usage-metrics', /no time filter|unbounded/i],
    ['cleanup', /NameError|defined only in cell 17/i],
    ['foundry-enable-a2a', /\*{6}|redaction artefact/i],
    ['circuit-breaker-check', /only iterates|never checked/i],
    ['apim-discovery', /without reporting how many|refuses to select silently/i],
  ];
  for (const [id, pattern] of requiredDisclosures) {
    const sample = byId.get(id);
    assert.ok(sample, `${id} is missing from the catalogue`);
    const text = sample.deviations.join(' ');
    assert.match(text, pattern, `${id} does not disclose its known notebook weakness`);
  }
});

test('the burst and cleanup recipes require an explicit non-production confirmation', () => {
  for (const id of ['tool-rate-limit-burst', 'agent-rate-limit-burst', 'cleanup']) {
    const sample = SAMPLES.find((candidate) => candidate.id === id);
    const field = sample.fields.find((candidate) => candidate.name === 'confirmNonProduction');
    assert.ok(field, `${id} has no non-production confirmation field`);
    assert.equal(field.classification, 'required');
    assert.equal(field.mustEqual, true);
    assert.equal(field.default, false, `${id} must not pre-confirm on the user's behalf`);
    assert.ok(field.mustEqualMessage?.length > 40, `${id} confirmation needs a real message`);
  }
});

test('every documentation link is https and points at an authoritative host', () => {
  const links = allLinks();
  assert.ok(links.length > 50, 'the catalogue should carry substantial reference material');
  for (const entry of links) {
    assert.ok(entry.label?.length > 2, `a link has no label: ${JSON.stringify(entry)}`);
    assert.match(entry.href, /^https:\/\//, `link "${entry.label}" is not https`);
    const host = new URL(entry.href).host;
    assert.ok(
      AUTHORITATIVE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
      `link "${entry.label}" points at ${host}, which is not an authoritative host`,
    );
  }
});

test('shared-profile guidance names how to obtain every required value', () => {
  for (const sample of SAMPLES) {
    for (const profile of profilesFor(sample)) {
      for (const field of profile.fields) {
        if (field.classification !== 'required') continue;
        assert.ok(
          /az |azd |portal|run |read /i.test(field.howToObtain),
          `${profile.id}.${field.name} acquisition guidance is not actionable`,
        );
      }
    }
  }
});
