import { sanitizeOperationalEvent } from './operational-events';

const MAX_CAUSES = 4;
const MESSAGE_LIMIT = 1024;
const STACK_LIMIT = 2048;
const STDERR_LIMIT = 4096;
const SECRET_KEY = /secret|token|password|api_?key|access_?key|authorization|postgres_url|database_url/i;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const AUTHORIZATION = /\b(Bearer|Basic)\s+[^\s,"'<>]+/gi;
const CREDENTIAL = /\b(?=[\w-]*(?:secret|token|password|api[_-]?key|access[_-]?key|signature|credential|authorization))([\w-]+)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&<>]+)/gi;

export function redactPipelineDiagnostic(text: string, environment: Record<string, string | undefined> = process.env) {
  let safe = text;
  const secrets = Object.entries(environment)
    .filter(([key, value]) => SECRET_KEY.test(key) && value)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]');
  return safe.replace(URL, '[URL REDACTED]')
    .replace(AUTHORIZATION, '$1 [REDACTED]')
    .replace(CREDENTIAL, '$1$2[REDACTED]');
}

function readProperty(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

export function emitPipelineFailureDiagnostic(
  error: unknown,
  context: Record<string, unknown>,
  sink: (serialized: string) => void = console.error
) {
  // Diagnostic failure must never replace the processing failure or affect recovery.
  try {
    const { event: _event, ...correlation } = sanitizeOperationalEvent('pipeline.invocation_failed', context);
    const causes: Record<string, string | number | boolean>[] = [];
    const seen = new Set<unknown>();
    let current = error;
    for (let depth = 0; depth < MAX_CAUSES && current != null && !seen.has(current); depth++) {
      seen.add(current);
      if (typeof current !== 'object' && typeof current !== 'function') {
        causes.push({ name: 'NonError', message: typeof current === 'string'
          ? redactPipelineDiagnostic(current).slice(0, MESSAGE_LIMIT) : 'Non-error value thrown.' });
        break;
      }
      const detail: Record<string, string | number | boolean> = {};
      for (const [field, limit] of [['name', 80], ['message', MESSAGE_LIMIT], ['stack', STACK_LIMIT], ['stderr', STDERR_LIMIT]] as const) {
        const value = readProperty(current, field);
        if (typeof value !== 'string') continue;
        const safe = redactPipelineDiagnostic(value);
        detail[field] = field === 'stderr' ? safe.slice(-limit) : safe.slice(0, limit);
      }
      for (const field of ['code', 'signal', 'statusCode', 'killed'] as const) {
        const value = readProperty(current, field);
        if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') detail[field] = value;
        else if (typeof value === 'string') detail[field] = redactPipelineDiagnostic(value).slice(0, 80);
      }
      causes.push(detail);
      current = readProperty(current, 'cause');
    }
    sink(JSON.stringify({ event: 'pipeline.failure_diagnostic', ...correlation, causes }));
  } catch { /* Diagnostics are best effort. */ }
}
