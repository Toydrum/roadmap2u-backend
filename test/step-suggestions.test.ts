import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountClosureKey } from '../lambda/account-closure';
import { K, type Deps, type ProfileItem } from '../lambda/db';
import { commonPrivacyDocumentHash } from '../lambda/privacy/consent';
import { handleEvent } from '../lambda/router';

const converse = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { readonly send = converse; },
  ConverseCommand: class { constructor(readonly input: unknown) {} },
}));

const owner = 'd1966825-7bb2-432f-a3e2-3bb26f6736cd';
const other = '866968e6-17b9-417b-ae24-b7de98d4056c';
const now = Date.parse('2026-11-16T23:00:00Z');
const path = '/v1/ai/step-suggestions';
const request = {
  language: 'es',
  treeTitle: 'Preparar un picnic de prueba',
  branchTitle: 'Armar una bolsa sintética',
  ancestorTitles: ['Elegir objetos'],
  existingStepTitles: ['Preparar una servilleta'],
};
const titles = ['Sacar una bolsa', 'Colocar los platos', 'Agregar un vaso'];
const ddb = mockClient(DynamoDBDocumentClient);

function profile(change: Partial<ProfileItem> = {}): ProfileItem {
  return {
    ...K.profile(owner), userId: owner, username: 'pilot', displayName: 'Pilot',
    accountType: 'adult', socialEnabled: false, status: 'active', createdAt: now - 1000,
    ...change,
  };
}

function deps(): Deps {
  return {
    table: 'roadmap-dev', userPoolId: 'pool', now: () => now,
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    cognito: {} as Deps['cognito'],
  };
}

function event(body = JSON.stringify(request), sub = owner, routePath = path, method = 'POST') {
  return {
    version: '2.0', routeKey: `${method} ${routePath}`, rawPath: routePath, rawQueryString: '',
    headers: {}, body, isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012', apiId: 'test', domainName: 'api.dev.roadmap2u.com',
      domainPrefix: 'api.dev', requestId: 'request', routeKey: `${method} ${routePath}`,
      stage: '$default', time: '16/Nov/2026:23:00:00 +0000', timeEpoch: now,
      http: { method, path: routePath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      authorizer: { principalId: sub, integrationLatency: 0, jwt: { claims: { sub }, scopes: [] } },
    },
  } satisfies APIGatewayProxyEventV2WithJWTAuthorizer;
}

function modelResponse(suggestions = titles, stopReason = 'end_turn') {
  return {
    stopReason,
    usage: { inputTokens: 212, outputTokens: 36 },
    output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ suggestions }) }] } },
  };
}

function conditionalCancellation(index: number) {
  return Object.assign(new Error('synthetic DynamoDB cancellation'), {
    name: 'TransactionCanceledException',
    CancellationReasons: Array.from({ length: 3 }, (_, i) => ({
      Code: index === i ? 'ConditionalCheckFailed' : 'None',
    })),
  });
}

describe('step suggestions pilot', () => {
  beforeEach(() => {
    vi.stubEnv('COMMERCIAL_STAGE', 'dev');
    vi.stubEnv('TASK_SUGGESTIONS_PILOT_SUBS', owner);
    vi.stubEnv('ADULT_PRIVACY_MODE', 'off');
    ddb.reset();
    ddb.on(GetCommand).resolves({});
    ddb.on(GetCommand, { Key: K.profile(owner) }).resolves({ Item: profile() });
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(TransactWriteCommand).resolves({});
    converse.mockReset().mockResolvedValue(modelResponse());
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reserves a daily attempt before one capped Nova Micro call', async () => {
    converse.mockImplementation(() => {
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
      return modelResponse();
    });

    const response = await handleEvent(event(), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: titles });
    expect(converse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      input: expect.objectContaining({ modelId: 'amazon.nova-micro-v1:0', inferenceConfig: expect.objectContaining({ maxTokens: 120 }) }),
    }), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    const written = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(written.ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(written.TransactItems).toEqual(expect.arrayContaining([
      { ConditionCheck: expect.objectContaining({ Key: K.profile(owner), ConditionExpression: expect.stringContaining('attribute_not_exists(privacyMode)') }) },
      { ConditionCheck: expect.objectContaining({ Key: accountClosureKey(owner) }) },
      { Update: expect.objectContaining({
        Key: { pk: K.user(owner), sk: 'RATE#STEP_SUGGESTIONS#2026-11-16' },
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeValues: expect.objectContaining({ ':limit': 10, ':ttl': Date.parse('2026-11-18T00:00:00Z') / 1000 }),
      }) },
    ]));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(request.branchTitle);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(owner);
  });

  it('passes only the selected focus and asks for distinct results within the branch', async () => {
    const context = { ...request, treeTitle: 'Aprender a dibujar', branchTitle: 'Aprender a dibujar',
      ancestorTitles: [], existingStepTitles: [], focus: 'Dibujar formas de objetos de casa' };

    const body = JSON.stringify({ ...context, focus: ` ${context.focus} ` });
    expect((await handleEvent(event(body), deps())).statusCode).toBe(200);

    expect(converse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      input: expect.objectContaining({
        system: [{ text: expect.stringContaining('different observable result') }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(context) }] }],
      }),
    }), expect.anything());
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(context.focus);
  });

  it('asks for and returns exactly one actionable title when the client requests one', async () => {
    const context = { ...request, treeTitle: 'Escritura', branchTitle: 'Escritura',
      ancestorTitles: [], existingStepTitles: ['Abrir el programa'] };
    const suggestion = 'Escribir la primera oración del borrador';
    converse.mockResolvedValue(modelResponse([suggestion]));

    const response = await handleEvent(event(JSON.stringify({ ...context, maxSuggestions: 1 })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: [suggestion] });
    expect(converse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      input: expect.objectContaining({
        system: [{ text: expect.stringContaining('single best next action') }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(context) }] }],
      }),
    }), expect.anything());
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it('rejects three titles from the model in single-step mode without retrying', async () => {
    const response = await handleEvent(event(JSON.stringify({ ...request, maxSuggestions: 1 })), deps());
    expect(response.statusCode).toBe(503);
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    ['es', 'Estoy de pie en agua baja. Sin sumergirme.', 'Sumergir la cabeza un momento'],
    ['es', 'Sin sumergirme y sin soltar el borde.', 'Respira sin prisa y sumérgete'],
    ['es', 'Mover solo los iconos. No borrar aplicaciones.', 'Borrar una aplicación que no uso'],
    ['es', 'Mover solo los iconos. Sin borrar nada.', 'Mover un icono y borrar otro'],
    ['es', 'No borres fotos.', 'Borrar una foto antigua'],
    ['en', 'Move the icons without deleting any apps.', 'Delete an unused app'],
    ['en', 'Rearrange the desk. Do not move the laptop.', 'Move the laptop to the shelf'],
    ['en', 'Do not delete photos and do not open settings.', 'Delete a photo'],
  ])('withholds a title that contains an explicit prohibited action (%s)', async (language, focus, suggestion) => {
    converse.mockResolvedValue(modelResponse([suggestion]));
    const body = JSON.stringify({ ...request, language, focus, maxSuggestions: 1 });
    const response = await handleEvent(event(body), deps());

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(suggestion);
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    ['es', 'Estoy de pie en agua baja. Sin sumergirme.', 'Practicar mi equilibrio sin sumergirme'],
    ['es', 'No mover el escritorio.', 'Mover un cuaderno al cajón'],
    ['en', 'Move the icons. Do not delete apps.', 'Move one icon without deleting an app'],
  ])('allows an action in a different scope or one that keeps the constraint (%s)', async (language, focus, suggestion) => {
    converse.mockResolvedValue(modelResponse([suggestion]));
    const body = JSON.stringify({ ...request, language, focus, maxSuggestions: 1 });
    const response = await handleEvent(event(body), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: [suggestion] });
  });

  it('exposes eligibility through /me only to a selected account in dev', async () => {
    const request = event('', owner, '/v1/me', 'GET');
    expect(JSON.parse((await handleEvent(request, deps())).body).stepSuggestionsPilot).toBe(true);
    vi.stubEnv('COMMERCIAL_STAGE', 'test');
    expect(JSON.parse((await handleEvent(request, deps())).body).stepSuggestionsPilot).toBeUndefined();
    expect(converse).not.toHaveBeenCalled();
  });

  it('admits a selected common account with current terms and local-only forest', async () => {
    vi.stubEnv('ADULT_PRIVACY_MODE', 'enforce');
    const Key = { pk: K.user(owner), sk: 'PRIVACY#ADULT' };
    ddb.on(GetCommand, { Key }).resolves({ Item: {
      ...Key, userId: owner, revision: 1, updatedAt: now, cloudConsent: 'absent', erasure: 'none',
      accountTermsAcceptedAt: now, accountTermsLanguage: 'es', accountTermsDocumentHash: commonPrivacyDocumentHash('es'),
    } });

    expect(JSON.parse((await handleEvent(event('', owner, '/v1/me', 'GET'), deps())).body).stepSuggestionsPilot).toBe(true);
    expect((await handleEvent(event(), deps())).statusCode).toBe(200);
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    { stage: 'test', subjects: owner },
    { stage: 'dev', subjects: '' },
    { stage: 'dev', subjects: other },
    { stage: 'dev', subjects: `${owner},malformed` },
    { stage: 'dev', subjects: Array(6).fill(owner).join(',') },
  ])('denies a disabled or invalid pilot configuration (%j)', async ({ stage, subjects }) => {
    vi.stubEnv('COMMERCIAL_STAGE', stage);
    vi.stubEnv('TASK_SUGGESTIONS_PILOT_SUBS', subjects);
    expect((await handleEvent(event(), deps())).statusCode).toBe(403);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(converse).not.toHaveBeenCalled();
  });

  it('rejects an account outside the cohort before parsing the input', async () => {
    vi.stubEnv('TASK_SUGGESTIONS_PILOT_SUBS', other);
    expect((await handleEvent(event('not valid JSON'), deps())).statusCode).toBe(403);
    expect(converse).not.toHaveBeenCalled();
  });

  it.each<Partial<ProfileItem>>([{ accountType: 'minor' }, { privacyMode: 'adolescent_private' }])(
    'denies ineligible profiles even in the cohort (%j)', async (change) => {
      ddb.on(GetCommand, { Key: K.profile(owner) }).resolves({ Item: profile(change) });
      expect((await handleEvent(event(), deps())).statusCode).toBe(403);
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(converse).not.toHaveBeenCalled();
    },
  );

  it('blocks closure before model invocation', async () => {
    ddb.on(GetCommand, { Key: accountClosureKey(owner) }).resolves({ Item: { closureId: 'closing' } });
    expect((await handleEvent(event(), deps())).statusCode).toBe(409);
    expect(converse).not.toHaveBeenCalled();
  });

  it.each([
    JSON.stringify({ ...request, notes: 'private' }),
    JSON.stringify({ ...request, focus: 'Pick one small part', notes: 'private' }),
    JSON.stringify({ ...request, focus: '  ' }),
    JSON.stringify({ ...request, focus: 'first line\nsecond line' }),
    JSON.stringify({ ...request, focus: 'f'.repeat(81) }),
    JSON.stringify({ ...request, focus: 1 }),
    JSON.stringify({ ...request, maxSuggestions: 3 }),
    JSON.stringify({ ...request, maxSuggestions: '1' }),
    JSON.stringify({ ...request, maxSuggestions: null }),
    JSON.stringify({ ...request, maxSuggestions: 1, notes: 'private' }),
    JSON.stringify({ ...request, language: 'fr' }),
    JSON.stringify({ ...request, ancestorTitles: ['1', '2', '3', '4'] }),
    JSON.stringify({ ...request, treeTitle: 'a'.repeat(81) }),
    JSON.stringify({ ...request, branchTitle: 'a\nsecond line' }),
    JSON.stringify(request) + ' '.repeat(2048),
  ])('rejects invalid or oversized input before reserving an attempt', async (body) => {
    expect((await handleEvent(event(body), deps())).statusCode).toBe(400);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(converse).not.toHaveBeenCalled();
  });

  it('admits only one request near the daily cap', async () => {
    let reserved = 9;
    ddb.on(TransactWriteCommand).callsFake(() => {
      if (reserved === 10) throw conditionalCancellation(2);
      reserved += 1;
      return {};
    });

    const results = await Promise.all([handleEvent(event(), deps()), handleEvent(event(), deps())]);

    expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([200, 429]);
    expect(results.find(({ statusCode }) => statusCode === 429)?.body).toContain('RATE_LIMITED');
    expect(converse).toHaveBeenCalledOnce();
  });

  it('blocks a closure recorded between the authoritative read and the reservation', async () => {
    ddb.on(TransactWriteCommand).rejects(conditionalCancellation(1));
    expect((await handleEvent(event(), deps())).statusCode).toBe(409);
    expect(converse).not.toHaveBeenCalled();
  });

  it.each([
    modelResponse(titles, 'max_tokens'),
    modelResponse([titles[0]!, titles[1]!, ' preparar   una SERVILLETA ']),
    modelResponse([titles[0]!, titles[0]!, titles[2]!]),
    modelResponse([titles[0]!, titles[1]!]),
  ])('fails closed on incomplete, duplicate or insufficient model output', async (payload) => {
    converse.mockResolvedValue(payload);
    const response = await handleEvent(event(), deps());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('STEP_SUGGESTIONS_UNAVAILABLE');
    expect(converse).toHaveBeenCalledOnce();
  });

  it('does not disclose unknown SDK errors even if they contain user text', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    converse.mockRejectedValue(new Error(request.branchTitle));
    const response = await handleEvent(event(), deps());
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(request.branchTitle);
    expect(errorLog).not.toHaveBeenCalled();
    expect(converse).toHaveBeenCalledOnce();
  });
});
