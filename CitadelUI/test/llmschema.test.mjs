/**
 * Exercises the LLM knowledge layer against the repository's real onboarding
 * file, so a mistake in the catalogue or the pool rule shows up here rather
 * than in the browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseBicepParam, nodeToValue } from '../server/bicepparam/parser.mjs';
import {
  BACKEND_TYPES,
  MODEL_CATALOG,
  backendType,
  effectiveAuthType,
  catalogFor,
  backendTemplate,
  modelTemplate,
  validateBackends,
  predictPools,
} from '../web/js/llmschema.mjs';
import { modelCatalogMatch } from '../web/js/llmview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const target = resolve(repo, 'bicep/infra/llm-backend-onboarding/main.bicepparam');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/* ------------------------------------------------ the real file parses out */

const text = readFileSync(target, 'utf8');
const doc = parseBicepParam(text);
const param = doc.params.find((p) => p.name === 'llmBackendConfig');

check('llmBackendConfig is present', Boolean(param));

const entries = param ? nodeToValue(param.value) : [];
check('llmBackendConfig is an array', Array.isArray(entries));
check('has at least one live backend', entries.length >= 1, `got ${entries.length}`);

/* ----------------------------------------- every live backend is understood */

for (const entry of entries) {
  const type = backendType(entry.backendType);
  check(
    `backendType "${entry.backendType}" is a known provider`,
    Boolean(type),
    'the catalogue is missing a type the repo actually uses'
  );
  check(
    `${entry.backendId} derives an auth type`,
    Boolean(effectiveAuthType(entry)),
    'auth derivation returned nothing'
  );
}

/* ------------------------------------- the shipped config validates cleanly */

const findings = validateBackends(entries);
const errors = findings.filter((f) => f.level === 'error');
check(
  'the repository config produces no validation errors',
  errors.length === 0,
  errors.map((e) => e.message).join('; ')
);

/* ----------------------------------------------------- pool prediction rule */

const pools = predictPools(entries);
check('predictPools returns a route per distinct model', pools.length > 0);
for (const pool of pools) {
  check(
    `pool "${pool.model}" is only pooled with 2+ backends`,
    pool.pooled === pool.backends.length >= 2,
    `pooled=${pool.pooled} backends=${pool.backends.length}`
  );
}

// A synthetic pair proves the composite key: same model, same provider, two
// backends -> one pool. Same model on a different provider must not join it.
const synthetic = [
  { backendId: 'a', backendType: 'azure-openai', endpoint: 'https://a/', supportedModels: [{ name: 'gpt-4o' }] },
  { backendId: 'b', backendType: 'azure-openai', endpoint: 'https://b/', supportedModels: [{ name: 'gpt-4o' }] },
  { backendId: 'c', backendType: 'ai-foundry', endpoint: 'https://c/', supportedModels: [{ name: 'gpt-4o' }] },
];
const spools = predictPools(synthetic);
const pooled = spools.filter((p) => p.pooled);
check('two same-provider backends form one pool', pooled.length === 1, `got ${pooled.length}`);
check(
  'a third backend on another provider stays direct',
  spools.length === 2 && spools.some((p) => !p.pooled),
  `routes=${spools.length}`
);
check(
  'pool name strips punctuation',
  pooled.length === 1 && /^[a-z0-9-]+$/.test(pooled[0].poolName),
  pooled.length ? pooled[0].poolName : 'no pool'
);

/* --------------------------------------------------- templates are complete */

for (const type of BACKEND_TYPES) {
  const template = backendTemplate(type.id);
  check(`${type.id} template has an id`, Boolean(template.backendId));
  check(`${type.id} template declares supportedModels`, Array.isArray(template.supportedModels));
  check(
    `${type.id} template validates or explains itself`,
    validateBackends([template]).every((f) => f.level !== 'error' || f.message.length > 0)
  );
}

/* ------------------------------------------- catalogue entries are coherent */

const foundryCatalogModel = catalogFor('ai-foundry')[0];
check(
  'expanded model editor resolves a Foundry catalogue match',
  Boolean(foundryCatalogModel) &&
    modelCatalogMatch(foundryCatalogModel.name, 'ai-foundry')?.name === foundryCatalogModel.name,
  'catalogEntry integration is unavailable'
);
check(
  'expanded model editor identifies custom deployment names',
  modelCatalogMatch('my-gpt-deployment', 'ai-foundry')?.kind === 'custom'
);

for (const model of MODEL_CATALOG) {
  check(`catalog "${model.name}" names its providers`, model.backendTypes.length > 0);
  for (const id of model.backendTypes) {
    check(`catalog "${model.name}" references a real provider`, Boolean(backendType(id)), id);
  }
  check(
    `catalog "${model.name}" is offered for its own provider`,
    catalogFor(model.backendTypes[0]).some((m) => m.name === model.name)
  );
}

// FLUX is the one provider where a missing field is a hard deploy failure.
const flux = modelTemplate('FLUX.2-pro', 'azure-flux');
check('FLUX template carries a modelPath', Boolean(flux.modelPath), JSON.stringify(flux));
const fluxBad = validateBackends([
  { backendId: 'f', backendType: 'azure-flux', endpoint: 'https://f/', supportedModels: [{ name: 'FLUX.2-pro' }] },
]);
check(
  'a FLUX model without modelPath is reported',
  fluxBad.some((f) => f.level === 'error' && /modelPath/i.test(f.message))
);

/* ----------------------------------------------------- duplicate detection */

const dupes = validateBackends([
  { backendId: 'same', backendType: 'azure-openai', endpoint: 'https://a/', supportedModels: [] },
  { backendId: 'same', backendType: 'azure-openai', endpoint: 'https://b/', supportedModels: [] },
]);
check(
  'duplicate backend ids are reported',
  dupes.some((f) => f.level === 'error' && /duplicate/i.test(f.message))
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
