/**
 * Explanations are authored here, never inferred from a request or exception
 * message. They describe possibilities and safe next steps, not a proven cause.
 */
const guide = (summary, meaning, next, level = 'error') => ({ summary, meaning, next, level });

const CODES = Object.freeze({
  INVALID_CONTENT: guide('The request did not match the expected input.',
    'Citadel rejected missing, incorrectly typed, or unsupported fields. Submitted values are deliberately absent.',
    'Review the visible validation beside the action. If the normal UI still sends this request, share this report.'),
  INVALID_JSON: guide('The request could not be parsed as JSON.',
    'The JSON payload was invalid; its contents were not captured.',
    'Retry the action from the normal UI. Repeated failures may indicate a client/server version mismatch.'),
  INVALID_SESSION: guide('The owner session was refused.',
    'The browser may hold a session issued before the server restarted.',
    'Sign in again as the existing owner. Do not recreate the owner or clear application data.'),
  INVALID_ORIGIN: guide('The request came from an unexpected origin.',
    'The request did not match the configured Citadel origin.',
    'Use the configured Citadel address. For hosted instances, check the allowed origin and ingress configuration.'),
  INVALID_FETCH_SITE: guide('The browser request failed the same-site check.',
    'Citadel refused a request not identified as coming from the supported browser transport.',
    'Open Citadel directly at its configured address rather than through another site or embedded page.'),
  INVALID_HOST: guide('The request host was not allowed.',
    'The request did not match the server host configuration.',
    'Use the configured host and port; check ingress host forwarding if the instance is hosted.'),
  BODY_TOO_LARGE: guide('The request exceeded a size limit.',
    'The server refused the payload before processing it. Payload bytes and file names are not captured.',
    'Reduce the operation size where supported. Share the operation and HTTP details if ordinary UI input reaches this limit.'),
  SERVER_BUSY: guide('The instance reached its concurrency limit.',
    'Too many application requests were in progress at once.',
    'Wait for current operations to finish, then retry once. Avoid repeatedly starting the same operation.'),
  NETWORK_ERROR: guide('The browser could not complete an application request.',
    'No usable HTTP failure response was available. Connectivity, a restart, or an interrupted response may be involved.',
    'Check that the Citadel page is reachable, then retry. This report has no network payloads or headers.'),
  REQUEST_ABORTED: guide('An application response did not finish.',
    'The connection closed before completion. The report does not establish whether a mutation already took effect.',
    'For a save, inspect the current source and transaction history before retrying.'),
  ENVIRONMENT_LEASED: guide('Another mutation already owns this environment.',
    'Citadel prevented overlapping writes.',
    'Let the current save or recovery finish before retrying. Do not bypass the lease.'),
  LEASE_LOST: guide('A save lost its mutation lease.',
    'The operation can no longer prove exclusive mutation authority.',
    'Inspect the workspace recovery state and transaction history before retrying.'),
  STALE_ORIGINAL_HASH: guide('The source changed after it was read.',
    'The current source does not match the reviewed baseline. No hashes or source bytes are included here.',
    'Reload and review the latest source before saving again; retain any edits you still need.'),
  STALE_MANIFEST_HASH: guide('The reviewed save manifest is stale.',
    'The operation no longer matches the authorized save plan.',
    'Return to the editor, refresh the source, and review a new save.'),
  GITHUB_TIMEOUT: guide('GitHub did not respond in time.',
    'Citadel ended a bounded GitHub request without a timely response.',
    'Check connectivity and retry after a pause. For a write, inspect current source/history first.'),
  GITHUB_RATE_LIMITED: guide('GitHub rate-limited the operation.',
    'The upstream service refused additional requests for now.',
    'Wait before retrying; repeated clicks can prolong the problem. No token or account identity is recorded.'),
  GITHUB_UNREACHABLE: guide('The server could not reach GitHub.',
    'The GitHub network boundary failed before it produced a usable response.',
    'Check the Citadel server connection to GitHub, then retry.'),
  GITHUB_INVALID_RESPONSE: guide('GitHub returned an unusable response.',
    'The response did not match the shape or encoding the operation expected. Its content is excluded.',
    'Retry once after a pause; share this report if it repeats.'),
  INDETERMINATE_SAVE: guide('A save may already have reached GitHub.',
    'The server could not confirm the final outcome. This is not a safe signal to create another commit.',
    'Use the existing save reconciliation/recovery UI and inspect the current branch before retrying.'),
  SAVE_NOT_APPLIED: guide('The server could not apply the save.',
    'Citadel reported that the attempted GitHub save was not applied.',
    'Follow the normal save retry or branch-selection prompt; do not use a force update.'),
  NATIVE_NUMBER_GRAMMAR: guide('The editor grammar does not support this valid Terraform number spelling.',
    'Integer-mantissa HCL exponents are a parser limitation, not a Terraform syntax error. The document remains read-only and unchanged.',
    'Use an external source editor. Do not round or normalize the number to work around the parser.'),
  NATIVE_SENSITIVE_FILE: guide('A native source contains a known-sensitive value.',
    'Ordinary source review, save, backup and history exposure are blocked for the whole file. No value or file alias is captured here.',
    'Keep credentials in your external Terraform workflow. Citadel does not remove secret bytes or prove arbitrary files secret-free.'),
  NATIVE_REVIEW_STALE: guide('The native source or its reviewed dependencies changed.',
    'The file, schema, policy, module inputs or shared GitHub head no longer match the approval.',
    'Retain the draft and review the current source. Follow the explicit Local conflict choice or GitHub exact-head workflow.'),
  NATIVE_CREATION_UNCONFIRMED: guide('A native file creation cannot be attributed safely.',
    'Matching bytes alone do not prove that Citadel owns an ambiguously created file.',
    'Keep or move the file outside Citadel. History recovery can close the attempt once the selected target is absent.'),
});

export function diagnosticGuidance(event) {
  const optionalProbe = event.status === 404 && ['GET', 'HEAD'].includes(event.method);
  if (optionalProbe && event.resource === '/.well-known/appspecific/com.chrome.devtools.json') {
    return guide('Optional Chrome DevTools metadata was not found.',
      'Chrome DevTools probes this endpoint for workspace integration. Citadel does not serve it; this is not an editor/save failure by itself.',
      'No action is normally needed unless you expected DevTools workspace integration.', 'info');
  }
  if (optionalProbe && event.resource === '/favicon.ico') {
    return guide('The optional browser site icon was not found.',
      'A browser requested the conventional favicon endpoint. Citadel uses its packaged page icon configuration instead.',
      'No action is normally needed if the application itself loads correctly.', 'info');
  }
  if (event.status === 404 && event.operation === 'asset') {
    return event.resource
      ? guide('A known application page or asset was not found.',
        'A packaged Citadel resource was requested but the server could not serve it. A stale page or incomplete image can cause this.',
        'Reload once. If it repeats, share this report with the deployed image/build identity.')
      : guide('A requested page or asset was not found.',
        'The requested name is not in the bundled-asset allowlist and is intentionally omitted. A stale link, typo, or browser tooling request is possible; the cause is not established.',
        'Reproduce from the normal Citadel UI. Use the recorded time and server correlation to investigate without sharing private URLs.');
  }
  if (Object.hasOwn(CODES, event.code)) return CODES[event.code];
  if (['EIO', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'DURABLE_BACKUP_VERIFICATION_FAILED', 'BACKUP_VERIFICATION_FAILED'].includes(event.code)) {
    return guide('A server storage operation failed.',
      'Citadel could not access or verify required application data. File paths and data contents are excluded.',
      'Check the UI data volume, available space and permissions. For a save, use transaction recovery before retrying.');
  }
  if (event.status === 401) return guide('The request was not authenticated.',
    'The required owner or connection session was not accepted.',
    'Follow the sign-in or reconnect prompt for this operation. Do not paste credentials into a report.');
  if (event.status === 403) return guide('The server refused this request.',
    'The operation failed an access or browser-transport check. This record alone does not identify the precise permission.',
    'Use the configured Citadel address and check the operation-specific access shown in the UI.');
  if (event.status === 404) return guide('The endpoint or selected item was not found.',
    'The requested operation could not resolve its endpoint or target. Target identities are intentionally excluded.',
    'Refresh the relevant workspace or connection. If the normal UI keeps producing this request, share this report.');
  if (event.status === 409) return guide('The operation conflicted with current state.',
    'A concurrency, stale-source, or lifecycle check refused the operation.',
    'Refresh and review the current state before retrying. Keep unsaved edits and follow any recovery prompt.');
  if (event.status === 429) return guide('The operation was rate-limited.',
    'The instance or upstream service refused further requests for now.',
    'Wait before retrying. Avoid repeatedly starting the same action.');
  if (event.status >= 500) return guide('The server could not complete the operation.',
    'An internal or upstream failure occurred. The report has only the known error code/class, not the exception text or stack.',
    'Share the report with the time of reproduction. For a save, check its existing history/recovery state before retrying.');
  if (event.status >= 400) return guide('The request was rejected.',
    'The application or transport rejected this request. Submitted values are not retained.',
    'Review the visible validation at the action, then retry from the normal UI.');
  if (event.category === 'unhandled-rejection') return guide('A browser promise failed without a handler.',
    'An asynchronous operation escaped the application error-handling boundary. String reasons and exception text are excluded.',
    'Note the action you were performing and share this report. Check for unsaved work before reloading.');
  if (event.category === 'uncaught') return guide('A browser error escaped the application handler.',
    'The bundled location identifies the error boundary when available; unknown or external locations are excluded.',
    'Share the report and the action you were performing. Retain unsaved work before reloading.');
  return guide('An application action reported an error.',
    'The reporting module and known exception class are available when recognized. Free-text errors and source values are deliberately excluded.',
    'Review the original error shown beside the action. Share this report with a short description of what you were doing, without credentials or source values.');
}
