/** Thin fetch wrapper. Every failure surfaces the server's message verbatim. */

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

export const api = {
  health: () => request('/api/health'),
  deployments: () => request('/api/deployments'),
  deployment: (path) => request(`/api/deployment?path=${encodeURIComponent(path)}`),
  preview: (path, operations) =>
    request('/api/preview', { method: 'POST', body: JSON.stringify({ path, operations }) }),
  save: (path, operations, expectedMtimeMs) =>
    request('/api/save', {
      method: 'POST',
      body: JSON.stringify({ path, operations, expectedMtimeMs }),
    }),
  focus: () => request('/api/focus'),
  onboardedModels: () => request('/api/onboarded-models'),
  policyVariables: () => request('/api/policy-variables'),
  contracts: () => request('/api/contracts'),
  contract: (id) => request(`/api/contract?id=${encodeURIComponent(id)}`),
  accessContractTargets: (environment) =>
    request(`/api/access-contract-targets${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`),
  createContract: (payload) =>
    request('/api/contract/create', { method: 'POST', body: JSON.stringify(payload) }),
  restoreContract: (id) =>
    request('/api/contract/restore', { method: 'POST', body: JSON.stringify({ id }) }),
  previewPolicy: (path, changes) =>
    request('/api/contract/policy/preview', {
      method: 'POST',
      body: JSON.stringify({ path, changes }),
    }),
  savePolicy: (payload) =>
    request('/api/contract/policy', { method: 'POST', body: JSON.stringify(payload) }),
  environments: () => request('/api/environments'),
  environment: (name) => request(`/api/environment?name=${encodeURIComponent(name)}`),
  saveEnvironment: (name, updates) =>
    request('/api/environment', { method: 'POST', body: JSON.stringify({ name, updates }) }),
  resolve: (environment, variables) =>
    request('/api/resolve', { method: 'POST', body: JSON.stringify({ environment, variables }) }),
};
