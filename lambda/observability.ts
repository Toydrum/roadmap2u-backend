type LogLevel = 'info' | 'warn' | 'error';

export interface ObservabilityContext {
  requestId: string;
  correlationId: string;
}

interface LambdaContextLike {
  awsRequestId?: string;
}

type EventLike = {
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string };
};

const REDACTED = '[REDACTED]';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const JWT_PATTERN = /(?:^|\s)eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\s|$)/;
const AUTHORIZATION_PATTERN = /^\s*(?:Bearer|Basic|Digest|HMAC|AWS4-HMAC-SHA256)\s+/i;
const OBSERVED_SERVICES = ['router', 'post-confirmation', 'pre-signup'] as const;
export type ObservedService = (typeof OBSERVED_SERVICES)[number];
const METRIC_UNITS: Readonly<Record<string, string>> = {
  InvocationSucceeded: 'Count',
  InvocationFailed: 'Count',
};
const METRIC_DIMENSION_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  service: new Set(OBSERVED_SERVICES),
  outcome: new Set(['success', 'failure']),
};

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized === 'authorization' ||
    normalized === 'body' ||
    normalized === 'code' ||
    normalized.endsWith('code') ||
    normalized.includes('jwt') ||
    normalized.includes('token') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('hmac') ||
    normalized.includes('signature') ||
    normalized.includes('cookie') ||
    normalized === 'email' ||
    normalized.includes('phone') ||
    normalized.includes('address') ||
    normalized === 'sub' ||
    normalized === 'userid' ||
    normalized === 'username' ||
    normalized === 'displayname' ||
    normalized === 'userattributes'
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return JWT_PATTERN.test(value) || AUTHORIZATION_PATTERN.test(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(item, seen),
    ]),
  );
}

function redact(details: Record<string, unknown>): Record<string, unknown> {
  return redactValue(details, new WeakSet()) as Record<string, unknown>;
}

function correlationHeader(headers: Record<string, string | undefined> | undefined): string | undefined {
  const entry = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'x-correlation-id',
  );
  const value = entry?.[1]?.trim();
  return value && CORRELATION_ID_PATTERN.test(value) ? value : undefined;
}

export function resolveObservabilityContext(
  event: unknown,
  context?: LambdaContextLike,
): ObservabilityContext {
  const source =
    event && typeof event === 'object'
      ? (event as EventLike)
      : {};
  const requestId = source.requestContext?.requestId || context?.awsRequestId || 'unknown';
  return {
    requestId,
    correlationId: correlationHeader(source.headers) ?? requestId,
  };
}

export function structuredLog(
  level: LogLevel,
  event: string,
  context: ObservabilityContext,
  details: Record<string, unknown> = {},
): void {
  const entry = {
    ...redact(details),
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId: context.requestId,
    correlationId: context.correlationId,
  };
  console[level](JSON.stringify(entry));
}

export function emitMetric(
  metricName: string,
  value: number,
  unit: string,
  context: ObservabilityContext,
  dimensions: Record<string, string> = {},
): void {
  const expectedUnit = METRIC_UNITS[metricName];
  if (!expectedUnit) throw new Error('metric is not allowlisted');
  if (unit !== expectedUnit) throw new Error('metric unit is not allowlisted');
  if (!Number.isFinite(value)) throw new Error('metric value must be finite');
  for (const [name, dimensionValue] of Object.entries(dimensions)) {
    const allowedValues = METRIC_DIMENSION_VALUES[name];
    if (!allowedValues) throw new Error('metric dimension is not allowlisted');
    if (!allowedValues.has(dimensionValue)) {
      throw new Error('metric dimension value is not allowlisted');
    }
  }
  console.info(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'RoadMap2U',
            Dimensions: [Object.keys(dimensions)],
            Metrics: [{ Name: metricName, Unit: unit }],
          },
        ],
      },
      ...dimensions,
      [metricName]: value,
      requestId: context.requestId,
      correlationId: context.correlationId,
    }),
  );
}

export function instrumentHandler<TEvent, TArgs extends unknown[], TResult>(
  service: ObservedService,
  handle: (event: TEvent, ...args: TArgs) => TResult | Promise<TResult>,
): (event: TEvent, ...args: TArgs) => Promise<TResult> {
  return async (event, ...args) => {
    const lambdaContext = args[0] as LambdaContextLike | undefined;
    const context = resolveObservabilityContext(event, lambdaContext);
    structuredLog('info', 'invocation.started', context, { service });
    try {
      const result = await handle(event, ...args);
      structuredLog('info', 'invocation.succeeded', context, { service });
      emitMetric('InvocationSucceeded', 1, 'Count', context, { service, outcome: 'success' });
      return result;
    } catch (error) {
      structuredLog('error', 'invocation.failed', context, { service, error });
      emitMetric('InvocationFailed', 1, 'Count', context, { service, outcome: 'failure' });
      throw error;
    }
  };
}
