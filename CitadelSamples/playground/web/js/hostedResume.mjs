const KEY = 'citadel-hosted-signin-resume';

export function saveHostedResume({ storage, sample, inputs, now = Date.now() }) {
  const allowed = new Set(sample.configurationEntries.filter((entry) => !entry.secret).map((entry) => entry.path));
  const safe = Object.fromEntries(Object.entries(inputs).filter(([path]) => allowed.has(path)));
  const payload = JSON.stringify({ recipeId: sample.id, inputs: safe, expires: now + 5 * 60 * 1000 });
  if (payload.length > 128 * 1024) throw new Error('The non-secret sign-in draft is too large.');
  storage.setItem(KEY, payload);
}

export function consumeHostedResume({ storage, catalogue, now = Date.now() }) {
  const raw = storage.getItem(KEY);
  storage.removeItem(KEY);
  if (!raw) return null;
  if (raw.length > 128 * 1024) throw new Error('The saved sign-in draft is invalid.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('The saved sign-in draft is invalid.'); }
  const sample = catalogue.byId.get(value?.recipeId);
  if (!sample || !Number.isFinite(value.expires) || value.expires <= now || value.expires > now + 5 * 60 * 1000) return null;
  if (!value.inputs || typeof value.inputs !== 'object' || Array.isArray(value.inputs)) throw new Error('The saved sign-in inputs are invalid.');
  const allowed = new Set(sample.configurationEntries.filter((entry) => !entry.secret).map((entry) => entry.path));
  if (Object.keys(value.inputs).some((path) => !allowed.has(path))) throw new Error('The saved sign-in draft contains undeclared inputs.');
  return { recipeId: sample.id, inputs: value.inputs };
}
