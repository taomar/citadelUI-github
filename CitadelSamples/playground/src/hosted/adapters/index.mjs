import { CATALOGUE } from '../../catalogue/index.mjs';
import { refuse } from '../request.mjs';

// W1 deliberately ships no additional executable adapter. Later milestones add reviewed static imports here.
export const STAGED_ADAPTER_IDS = Object.freeze([]);

export function createAdapterRegistry({ testAdapters } = {}) {
  if (testAdapters !== undefined && !process.env.NODE_TEST_CONTEXT) throw new TypeError('Adapter injection is restricted to the Node test runner.');
  const definitions = testAdapters ?? [];
  if (!Array.isArray(definitions) || definitions.length > 18) throw new TypeError('Invalid test adapter registry.');
  const entries = new Map();
  for (const adapter of definitions) {
    const generatedFields = adapter.generatedFields ?? [];
    if (!CATALOGUE.byId.has(adapter.id) || adapter.id === 'agent-framework-hr-question' || entries.has(adapter.id)
      || !/^[\w.-]{1,64}$/.test(adapter.version) || typeof adapter.policyId !== 'string' || adapter.policyId.length > 128
      || !Array.isArray(adapter.resolvePurposes) || adapter.resolvePurposes.some((purpose) => purpose !== 'azure')
      || !Array.isArray(generatedFields) || generatedFields.length > 1
      || generatedFields.some((field) => field !== 'gatewayAccess.apiKey' || adapter.id !== 'access-contract-deploy')
      || !['resolve', 'execute', 'authorizeRequest', 'reconcile'].every((name) => typeof adapter[name] === 'function')) {
      throw new TypeError('Invalid closed adapter definition.');
    }
    entries.set(adapter.id, Object.freeze({ ...adapter, resolvePurposes: Object.freeze([...adapter.resolvePurposes]),
      generatedFields: Object.freeze([...generatedFields]) }));
  }
  return Object.freeze({
    ids: Object.freeze([...entries.keys()]),
    get(id) {
      const adapter = entries.get(id);
      if (!adapter) refuse('No reviewed staged adapter is enabled for this recipe.', 'hosted-recipe-unavailable', 403);
      return adapter;
    },
  });
}
