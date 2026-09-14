import { MAX_GITHUB_COMMIT_REQUEST_BYTES } from './source-scope.mjs';

/** Empty after strings plus their base64 lengths measure a request without encoding file buffers. */
export function assertGitHubRequestBudget(body, additionalBytes = 0) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error('Invalid encoded request size.');
  const encodedBytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).byteLength + additionalBytes;
  if (encodedBytes > MAX_GITHUB_COMMIT_REQUEST_BYTES) {
    throw Object.assign(new Error(
      `This GitHub change needs ${encodedBytes} encoded request bytes, exceeding the ${MAX_GITHUB_COMMIT_REQUEST_BYTES} byte (12 MiB) limit. Reduce the file sizes or split the change into smaller reviewed actions. Each file must also stay within 8 MiB; base64, request framing and review metadata count toward the total. No GitHub mutation was submitted.`
    ), { code: 'GITHUB_REQUEST_TOO_LARGE', status: 413, encodedBytes, limit: MAX_GITHUB_COMMIT_REQUEST_BYTES });
  }
  return { encodedBytes, limit: MAX_GITHUB_COMMIT_REQUEST_BYTES };
}
