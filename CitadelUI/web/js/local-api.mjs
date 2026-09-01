export async function localRequest(path, options = {}) {
  const token = document.querySelector('meta[name="citadel-session"]')?.content;
  const { responseType = 'json', ...fetchOptions } = options;
  const res = await fetch(path, {
    ...fetchOptions,
    headers: {
      ...(options.body && !(options.headers && 'Content-Type' in options.headers)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(token ? { 'X-Citadel-Session': token } : {}),
      ...(options.headers || {}),
    },
  });
  if (responseType === 'bytes' && res.ok) {
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      hash: res.headers.get('X-Citadel-Content-SHA256'),
    };
  }
  const body = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) {
    const detail = typeof body.error === 'object' ? body.error : body;
    const message =
      (typeof body.error === 'string' ? body.error : detail.message) ||
      `Request failed: ${res.status}`;
    const correlationId = detail.correlationId || body.correlationId;
    const suffix = correlationId ? ` (correlation ${correlationId})` : '';
    throw new Error(`${message}${suffix}`);
  }
  return body;
}
