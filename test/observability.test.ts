import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitCommercialBrokerAvailabilityMetric,
  emitCommercialMetric,
  emitMetric,
  instrumentHandler,
  resolveObservabilityContext,
  structuredLog,
} from '../lambda/observability';
import { handler as postConfirmationHandler } from '../lambda/post-confirmation';
import { handler as preSignupHandler } from '../lambda/pre-signup';
import { handler as routerHandler } from '../lambda/router';

const REQUEST = {
  requestId: 'request-123',
  correlationId: 'correlation-456',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('observability', () => {
  it('redacts sensitive fields recursively before writing a structured log', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const secrets = {
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
      authorization: 'Bearer private-authorization',
      body: '{"email":"private@example.com"}',
      accessCode: 'R2U-ACCESS-SECRET',
      hmac: 'private-hmac',
      clientSecret: 'private-client-secret',
      password: 'private-password',
      email: 'private@example.com',
      refreshToken: 'private-refresh-token',
    };

    structuredLog('info', 'capture.test', REQUEST, {
      safe: 'visible',
      Authorization: secrets.authorization,
      body: secrets.body,
      nested: {
        accessCode: secrets.accessCode,
        hmac: secrets.hmac,
        clientSecret: secrets.clientSecret,
        password: secrets.password,
        jwt: secrets.jwt,
        email: secrets.email,
      },
      list: [{ refreshToken: secrets.refreshToken }],
    });

    expect(info).toHaveBeenCalledOnce();
    const line = info.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'capture.test',
      requestId: REQUEST.requestId,
      correlationId: REQUEST.correlationId,
      safe: 'visible',
    });
    expect(line).toContain('[REDACTED]');
    for (const secret of Object.values(secrets)) {
      expect(line).not.toContain(secret);
    }
  });

  it('does not allow details to overwrite structured log fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    structuredLog('warn', 'trusted.event', REQUEST, {
      timestamp: 'forged-timestamp',
      level: 'error',
      event: 'forged.event',
      requestId: 'forged-request',
      correlationId: 'forged-correlation',
    });

    const parsed = JSON.parse(warn.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed.timestamp).not.toBe('forged-timestamp');
    expect(parsed).toMatchObject({
      level: 'warn',
      event: 'trusted.event',
      requestId: REQUEST.requestId,
      correlationId: REQUEST.correlationId,
    });
  });

  it('emits CloudWatch Embedded Metric Format with trace identifiers', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    emitMetric('InvocationSucceeded', 1, 'Count', REQUEST, {
      service: 'router',
      outcome: 'success',
    });

    expect(info).toHaveBeenCalledOnce();
    const parsed = JSON.parse(info.mock.calls[0]?.[0] as string) as {
      _aws: {
        CloudWatchMetrics: Array<{
          Namespace: string;
          Dimensions: string[][];
          Metrics: Array<{ Name: string; Unit: string }>;
        }>;
      };
      InvocationSucceeded: number;
      requestId: string;
      correlationId: string;
      service: string;
      outcome: string;
    };
    expect(parsed._aws.CloudWatchMetrics).toEqual([
      {
        Namespace: 'RoadMap2U',
        Dimensions: [['service', 'outcome']],
        Metrics: [{ Name: 'InvocationSucceeded', Unit: 'Count' }],
      },
    ]);
    expect(parsed).toMatchObject({
      InvocationSucceeded: 1,
      requestId: REQUEST.requestId,
      correlationId: REQUEST.correlationId,
      service: 'router',
      outcome: 'success',
    });
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions[0]).not.toContain('requestId');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions[0]).not.toContain('correlationId');
  });

  it('rejects unbounded metric names, units, dimension names, and dimension values', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(() => emitMetric('PerUserMetric', 1, 'Count', REQUEST, { service: 'router' })).toThrow(
      'metric is not allowlisted',
    );
    expect(() => emitMetric('InvocationSucceeded', 1, 'Bytes', REQUEST, { service: 'router' })).toThrow(
      'metric unit is not allowlisted',
    );
    expect(() =>
      emitMetric('InvocationSucceeded', 1, 'Count', REQUEST, {
        service: 'router',
        requestId: 'high-cardinality-request',
      }),
    ).toThrow('metric dimension is not allowlisted');
    expect(() =>
      emitMetric('InvocationSucceeded', 1, 'Count', REQUEST, {
        service: 'per-user-service-name',
      }),
    ).toThrow('metric dimension value is not allowlisted');
  });

  it('emits allowlisted commercial EMF without identifiers or personal data', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    emitCommercialMetric('ConfigurationDrift', 'dev');

    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      _aws: {
        Timestamp: expect.any(Number),
        CloudWatchMetrics: [
          {
            Namespace: 'RoadMap2U',
            Dimensions: [['stage']],
            Metrics: [{ Name: 'ConfigurationDrift', Unit: 'Count' }],
          },
        ],
      },
      stage: 'dev',
      ConfigurationDrift: 1,
    });
    expect(line).not.toMatch(/requestId|correlationId|email|username|body|code|token/i);
    expect(() => emitCommercialMetric('PerUserMetric' as never, 'dev')).toThrow(
      'commercial metric is not allowlisted',
    );
    expect(() => emitCommercialMetric('ConfigurationDrift', 'preview' as never)).toThrow(
      'commercial metric stage is not allowlisted',
    );
  });

  it('emits unavailability only for a config broker 503 response', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    emitCommercialBrokerAvailabilityMetric(409, 'test');
    emitCommercialBrokerAvailabilityMetric(503, 'test');

    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]?.[0])).toContain(
      'CommercialConfigurationUnavailable',
    );
  });

  it('derives a bounded correlation id and falls back to the request id', () => {
    expect(
      resolveObservabilityContext(
        {
          headers: { 'X-Correlation-Id': '  journey-123  ' },
          requestContext: { requestId: 'api-request' },
        },
        { awsRequestId: 'lambda-request' },
      ),
    ).toEqual({ requestId: 'api-request', correlationId: 'journey-123' });

    expect(
      resolveObservabilityContext(
        {
          headers: { 'x-correlation-id': 'not valid because it contains spaces' },
        },
        { awsRequestId: 'lambda-request' },
      ),
    ).toEqual({ requestId: 'lambda-request', correlationId: 'lambda-request' });
  });

  it('instruments a handler without logging input/output or changing its arguments and result', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = { accessToken: 'never-log-this-output' };
    const lambdaContext = { awsRequestId: 'lambda-request' };
    let receivedContext: typeof lambdaContext | undefined;
    const wrapped = instrumentHandler(
      'pre-signup',
      async (event: { body: string }, context: typeof lambdaContext) => {
        receivedContext = context;
        expect(event.body.length).toBeGreaterThan(0);
        return result;
      },
    );

    await expect(wrapped({ body: 'never-log-this-body' }, lambdaContext)).resolves.toBe(result);

    const capture = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(receivedContext).toBe(lambdaContext);
    expect(capture).not.toContain('never-log-this-body');
    expect(capture).not.toContain('never-log-this-output');
    expect(capture).toContain('lambda-request');
    expect(capture).toContain('InvocationSucceeded');
  });

  it('accepts only allowlisted service names at compile time', () => {
    if (false) {
      // @ts-expect-error High-cardinality service names must be added to the explicit allowlist.
      instrumentHandler('per-user-service', async (_event: object) => undefined);
    }
    expect(true).toBe(true);
  });

  it('allows only the three bounded commercial HTTP entrypoint service names', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    for (const service of [
      'catalog',
      'access-reader',
      'account-closure-request',
    ] as const) {
      const wrapped = instrumentHandler(service, async () => ({ statusCode: 204 }));
      await expect(wrapped({})).resolves.toEqual({ statusCode: 204 });
    }

    const capture = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(capture).toContain('"service":"catalog"');
    expect(capture).toContain('"service":"access-reader"');
    expect(capture).toContain('"service":"account-closure-request"');
  });

  it('instruments the real public catalog and JWT access entrypoints without logging requests', async () => {
    vi.stubEnv('TABLE_NAME', 'roadmap-dev');
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const [{ handler: catalogHandler }, { handler: accessHandler }] = await Promise.all([
      import('../lambda/catalog'),
      import('../lambda/access-reader'),
    ]);
    const secret = 'never-log-commercial-http-request';

    await expect(
      catalogHandler(
        {
          body: secret,
          headers: { authorization: `Bearer ${secret}` },
          requestContext: { requestId: 'catalog-request' },
        },
        { awsRequestId: 'catalog-lambda' },
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      accessHandler(
        {
          body: secret,
          headers: { authorization: `Bearer ${secret}` },
          requestContext: { requestId: 'access-request', http: { method: 'GET' } },
        } as never,
        { awsRequestId: 'access-lambda' },
      ),
    ).resolves.toMatchObject({ statusCode: 401 });

    const capture = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(capture).toContain('"service":"catalog"');
    expect(capture).toContain('"requestId":"catalog-request"');
    expect(capture).toContain('"service":"access-reader"');
    expect(capture).toContain('"requestId":"access-request"');
    expect(capture).not.toContain(secret);
  });

  it('rethrows the exact handler error without logging a sensitive message', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sentinel = new Error('accessCode=never-log-this-error-secret');
    const wrapped = instrumentHandler('router', async (_event: object, _context?: object) => {
      throw sentinel;
    });

    await expect(wrapped({}, { awsRequestId: 'lambda-request' })).rejects.toBe(sentinel);

    const capture = [...info.mock.calls, ...error.mock.calls]
      .map(([line]) => String(line))
      .join('\n');
    expect(capture).not.toContain('never-log-this-error-secret');
    expect(capture).toContain('InvocationFailed');
  });

  it('instruments the router and Cognito entrypoints without changing their responses', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const routerEvent = {
      version: '2.0',
      rawPath: '/v1/me',
      rawQueryString: '',
      headers: {
        authorization: 'Bearer never-log-entrypoint-authorization',
        'x-correlation-id': 'browser-journey',
      },
      body: 'never-log-entrypoint-body',
      requestContext: {
        requestId: 'api-request',
        http: { method: 'OPTIONS' },
      },
      isBase64Encoded: false,
    };
    const preSignupEvent = {
      triggerSource: 'PreSignUp_AdminCreateUser',
      userName: 'valid_user',
      request: { userAttributes: {} },
    };
    const postConfirmationEvent = {
      triggerSource: 'PostConfirmation_ConfirmForgotPassword',
      request: { userAttributes: {} },
    };

    await expect(
      routerHandler(routerEvent as never, { awsRequestId: 'lambda-router' } as never),
    ).resolves.toEqual({ statusCode: 204, headers: {}, body: '' });
    await expect(
      preSignupHandler(preSignupEvent as never, { awsRequestId: 'lambda-pre-signup' } as never),
    ).resolves.toBe(preSignupEvent);
    await expect(
      postConfirmationHandler(
        postConfirmationEvent as never,
        { awsRequestId: 'lambda-post-confirmation' } as never,
      ),
    ).resolves.toBe(postConfirmationEvent);

    const capture = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(capture).toContain('"service":"router"');
    expect(capture).toContain('"requestId":"api-request"');
    expect(capture).toContain('"correlationId":"browser-journey"');
    expect(capture).toContain('"service":"pre-signup"');
    expect(capture).toContain('"requestId":"lambda-pre-signup"');
    expect(capture).toContain('"service":"post-confirmation"');
    expect(capture).toContain('"requestId":"lambda-post-confirmation"');
    expect(capture).not.toContain('never-log-entrypoint-authorization');
    expect(capture).not.toContain('never-log-entrypoint-body');
  });

  it('instruments the config broker without logging its body, actor, or reason', async () => {
    vi.stubEnv('TABLE_NAME', 'roadmap-dev');
    vi.stubEnv('AUDIT_TABLE_NAME', 'roadmap-access-audit-dev');
    vi.stubEnv('COMMERCIAL_STAGE', 'dev');
    vi.stubEnv(
      'COMMERCIAL_CONFIG_ALLOWLIST',
      JSON.stringify([
        {
          accountId: '765932874577',
          roleName: 'roadmap2u-dev-commercial-migration',
          stage: 'dev',
          commands: ['bootstrap-flags', 'freeze-cutover'],
        },
        {
          accountId: '765932874577',
          roleName: 'roadmap2u-dev-commercial-flag-operator',
          stage: 'dev',
          commands: ['set-flags'],
        },
      ]),
    );
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const actor =
      'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-commercial-migration/private-session';
    const reason = 'private commercial operator reason';
    const body = JSON.stringify({ command: 'bootstrap-flags', stage: 'test', reason });
    const module = await import('../lambda/commercial-config-broker-handler');

    await expect(
      module.handler(
        {
          body,
          requestContext: {
            requestId: 'function-url-request',
            http: { method: 'POST' },
            authorizer: { iam: { userArn: actor } },
          },
        },
        { awsRequestId: 'lambda-request' } as never,
      ),
    ).resolves.toMatchObject({ statusCode: 403 });

    const capture = info.mock.calls.map(([line]) => String(line)).join('\n');
    expect(capture).toContain('"service":"commercial-config-broker"');
    expect(capture).toContain('function-url-request');
    expect(capture).not.toContain(body);
    expect(capture).not.toContain(actor);
    expect(capture).not.toContain(reason);
  });
});
