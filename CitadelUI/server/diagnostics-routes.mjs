import {
  DIAGNOSTICS_ENDPOINT, DIAGNOSTICS_LIMITS, copyClientDiagnostic,
  copyDiagnosticReport, copyDiagnosticState, diagnosticFilename, exactKeys, isDiagnosticId, validClientDiagnostic,
} from '../shared/diagnostics.mjs';
import { diagnosticsError } from './diagnostics.mjs';

const ROUTES = Object.freeze({
  status: 'GET', report: 'GET', download: 'GET', capture: 'POST', clear: 'POST', events: 'POST',
});

/** Called only after the normal owner, Host, Fetch-Site and Origin guards. */
export async function handleDiagnostics({ req, url, diagnostics, readBody, sendJson, sendDownload }) {
  const action = url.pathname.slice(DIAGNOSTICS_ENDPOINT.length + 1);
  if (!Object.hasOwn(ROUTES, action) || url.search) throw diagnosticsError('DIAGNOSTICS_INVALID');
  if (req.method !== ROUTES[action]) {
    return sendJson(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, { Allow: ROUTES[action] });
  }
  const kind = action === 'events' ? 'ingest' : action === 'download' ? 'download' : req.method === 'GET' ? 'read' : 'control';
  try {
    diagnostics.limitRequest(kind);
    if (action === 'status') return sendJson(200, copyDiagnosticState(diagnostics.status()));
    if (action === 'report') return sendJson(200, copyDiagnosticReport(diagnostics.report()));
    if (action === 'download') {
      const report = copyDiagnosticReport(diagnostics.report());
      return sendDownload(`${JSON.stringify(report, null, 2)}\n`, diagnosticFilename(report));
    }
    const body = await readBody(DIAGNOSTICS_LIMITS.bodyBytes);
    if (action === 'capture') {
      if (!exactKeys(body, ['enabled', 'expectedCaptureId'])) throw diagnosticsError('DIAGNOSTICS_INVALID');
      return sendJson(200, diagnostics.setEnabled(body.enabled, body.expectedCaptureId));
    }
    if (action === 'clear') {
      if (!exactKeys(body, ['expectedCaptureId']) ||
          (body.expectedCaptureId !== null && !isDiagnosticId(body.expectedCaptureId))) throw diagnosticsError('DIAGNOSTICS_INVALID');
      return sendJson(200, diagnostics.clear(body.expectedCaptureId));
    }
    if (!exactKeys(body, ['captureId', 'events', 'clientQueueOmitted']) || !isDiagnosticId(body.captureId) ||
        !Array.isArray(body.events) || body.events.length > DIAGNOSTICS_LIMITS.batchEvents ||
        !Number.isInteger(body.clientQueueOmitted) || body.clientQueueOmitted < 0 || body.clientQueueOmitted > 1000 ||
        !body.events.every(validClientDiagnostic)) throw diagnosticsError('DIAGNOSTICS_INVALID');
    return sendJson(200, diagnostics.ingest(body.captureId, body.events.map(copyClientDiagnostic), body.clientQueueOmitted));
  } catch (error) {
    if (action === 'events') diagnostics.rejectBatch();
    throw error;
  }
}
