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
const knightRequest = {
  language: 'es', treeTitle: 'Aprender ajedrez', branchTitle: 'Practicar el movimiento del caballo',
  ancestorTitles: [], existingStepTitles: ['Poner un caballo en d4'], maxSuggestions: 1,
};
const roomRequest = {
  language: 'es', treeTitle: 'Recoger mi cuarto', branchTitle: 'Recoger mi cuarto',
  ancestorTitles: [], existingStepTitles: [], maxSuggestions: 1,
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

function modelObjective(fields: object) {
  return { ...modelResponse(), output: { message: { content: [{ text: JSON.stringify(fields) }] } } };
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

  it('renders exactly one concrete objective from one model call when context needs interpretation', async () => {
    const context = { ...roomRequest, treeTitle: 'Preparar mi mochila', branchTitle: 'Preparar mi mochila',
      focus: 'Solo ropa. La mochila está en la cama.' };
    const { maxSuggestions: _count, ...modelContext } = context;
    converse.mockResolvedValue(modelObjective({ action: 'Poner', object: 'una prenda', target: 'en la mochila' }));

    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Poner una prenda en la mochila'] });
    expect(converse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      input: expect.objectContaining({
        system: [{ text: expect.stringContaining('one completed result') }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(modelContext) }] }],
      }),
    }), expect.anything());
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it.each([
    [{}, 'Guardar un objeto que esté fuera de lugar'],
    [{ focus: 'Ropa en el suelo. El cesto está junto a la puerta.' }, 'Poner una prenda del suelo en el cesto'],
    [{ treeTitle: 'Ordenar el escritorio', branchTitle: 'Ordenar el escritorio' }, 'Guardar un objeto que esté fuera de lugar'],
    [{ branchTitle: 'Despejar el centro del escritorio' }, 'Retirar un objeto del centro del escritorio'],
    [{ language: 'en', treeTitle: 'Organize my work area', branchTitle: 'Clear the center of the workbench' },
      'Remove one item from the center of the workbench'],
    [{ treeTitle: 'Ponerme al día con el correo', branchTitle: 'Responder el correo de confirmación',
      existingStepTitles: ['Leer la pregunta'] }, 'Escribir la primera frase de la respuesta'],
    [{ treeTitle: 'Preparar mi mochila', branchTitle: 'Preparar mi mochila',
      focus: 'La mochila ya está abierta. Solo ropa para una noche.' }, 'Poner una prenda en la mochila'],
    [{ treeTitle: 'Organizar la semana', branchTitle: 'Organizar la semana',
      focus: 'Dejar libre la tarde del jueves. Ya tengo el calendario abierto.' }, 'Marcar la tarde del jueves como libre en el calendario'],
    [{ language: 'en', treeTitle: 'Get ready for tomorrow', branchTitle: 'Set out my clothes',
      existingStepTitles: ['Choose a clean shirt'] }, 'Set out the clean shirt'],
    [{ treeTitle: 'Coordinar la reunión del equipo', branchTitle: 'Elegir un horario',
      focus: 'Me ofrecieron martes a las 10 y jueves a las 15. Aún no he confirmado.' }, 'Anotar cuál de los dos horarios prefiero'],
  ])('uses a small finished action when the ordinary context provides enough information (%j)', async (context, suggestion) => {
    const response = await handleEvent(event(JSON.stringify({ ...roomRequest, ...context })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: [suggestion] });
    expect(converse).not.toHaveBeenCalled();
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it.each([
    { suggestions: ['Ordenar una esquina'] },
    { title: 'Ordenar una esquina', evidence: 'ordenar' },
    { action: 'Poner', object: 'una camiseta sucia', target: 'en el cesto' },
    { action: 'Poner', object: 'un objeto', target: 'en el armario' },
    { action: 'Poner', object: 'un objeto del frasco', target: 'en el cesto' },
    { action: 'Poner una camiseta en', object: 'el cesto' },
    { action: 'Poner', object: 'un objeto' },
    { action: 'Retirar', object: 'cinco objetos', target: 'de la mesa' },
    { action: 'Hacer', object: 'el siguiente paso', target: 'para la mesa' },
    { action: 'Recoger', object: 'mi cuarto' },
  ])('withholds vague titles and ungrounded details for an ordinary branch (%j)', async (payload) => {
    converse.mockResolvedValue(modelObjective(payload));
    const response = await handleEvent(event(JSON.stringify({ ...roomRequest, focus: 'Despejar la mesa. El cesto está a mano.' })), deps());

    expect(response.statusCode).toBe(503);
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    ['El cesto está junto a la mesa.', 'al cesto', 'Mover un objeto al cesto'],
    ['La caja está junto a la mesa.', 'a la caja', 'Mover un objeto a la caja'],
  ])('uses the named destination when the branch stays the same (%s)', async (focus, target, title) => {
    converse.mockResolvedValue(modelObjective({ action: 'Mover', object: 'un objeto', target }));
    const response = await handleEvent(event(JSON.stringify({ ...roomRequest, branchTitle: 'Despejar la mesa', focus })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: [title] });
  });

  it('allows a single named part with its separately supported destination', async () => {
    const context = { ...roomRequest, treeTitle: 'Preparar el desayuno', branchTitle: 'Armar un sándwich frío',
      focus: 'El pan está listo. Tengo queso en rebanadas.' };
    converse.mockResolvedValue(modelObjective({ action: 'Colocar', object: 'una rebanada de queso', target: 'sobre el pan' }));
    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Colocar una rebanada de queso sobre el pan'] });
  });

  it('rejects a compound object made from unrelated words in one sentence', async () => {
    const context = { ...roomRequest, branchTitle: 'Despejar la mesa',
      focus: 'La caja roja está junto a una bolsa azul. El armario está abierto.' };
    converse.mockResolvedValue(modelObjective({ action: 'Poner', object: 'la caja azul', target: 'en el armario' }));

    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(503);
  });

  it.each([
    ['El cesto está junto a la mesa. No usar el cesto.', 'en el cesto'],
    ['El cesto está junto a la mesa.', 'del cesto'],
  ])('rejects an excluded destination or a bare source for a move (%s)', async (focus, target) => {
    const context = { ...roomRequest, branchTitle: 'Despejar la mesa', focus };
    converse.mockResolvedValue(modelObjective({ action: 'Mover', object: 'un objeto', target }));

    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(503);
  });

  it.each([
    ['es', 'Dejarlo listo', undefined, []],
    ['es', 'Dejarlo listo', undefined, ['Empezar']],
    ['en', 'Get it ready', 'I checked yesterday’s thing. I want to do the next step.', []],
  ])('asks what the user means before reserving an attempt (%s)', async (language, title, focus, existingStepTitles) => {
    const context = { ...roomRequest, language, treeTitle: title, branchTitle: title, focus, existingStepTitles };
    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toEqual({ code: 'STEP_SUGGESTIONS_CONTEXT_REQUIRED', message: 'object' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(converse).not.toHaveBeenCalled();
  });

  it('uses a supplied answer to an ambiguous branch', async () => {
    const context = { ...roomRequest, treeTitle: 'Dejarlo listo', branchTitle: 'Dejarlo listo',
      focus: 'Quiero doblar la camiseta. Ya está sobre la cama.' };
    converse.mockResolvedValue(modelObjective({ action: 'Doblar', object: 'la camiseta' }));
    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Doblar la camiseta'] });
    expect(converse).toHaveBeenCalledOnce();
  });

  it('uses a specific ancestor when a child title alone is vague', async () => {
    const context = { ...roomRequest, treeTitle: 'Preparar el desayuno', branchTitle: 'Dejarlo listo',
      ancestorTitles: ['Preparar la servilleta para servir'] };
    converse.mockResolvedValue(modelObjective({ action: 'Doblar', object: 'la servilleta' }));

    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Doblar la servilleta'] });
  });

  it('preserves an explicitly supplied filename as the outcome', async () => {
    const context = { ...roomRequest, treeTitle: 'Preparar una entrega', branchTitle: 'Nombrar el PDF de la entrega',
      focus: 'El nombre solicitado es Presupuesto.pdf. Ya abrí la carpeta.' };
    converse.mockResolvedValue(modelObjective({ action: 'Renombrar', object: 'el PDF', target: 'como Presupuesto.pdf' }));

    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Renombrar el PDF como Presupuesto.pdf'] });
  });

  it('asks for one missing detail after a model call with the usual quota reservation', async () => {
    converse.mockResolvedValue(modelObjective({ clarify: 'destination' }));
    const response = await handleEvent(event(JSON.stringify({ ...roomRequest, branchTitle: 'Mover la caja' })), deps());

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toEqual({ code: 'STEP_SUGGESTIONS_CONTEXT_REQUIRED', message: 'destination' });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(converse).toHaveBeenCalledOnce();
  });

  it('rejects a repeat with different articles and punctuation', async () => {
    const context = { ...roomRequest, branchTitle: 'Preparar el desayuno', focus: 'El pan está listo.', existingStepTitles: ['Cortar una rebanada de pan.'] };
    converse.mockResolvedValue(modelObjective({ action: 'Cortar', object: 'la rebanada de pan' }));
    const response = await handleEvent(event(JSON.stringify(context)), deps());

    expect(response.statusCode).toBe(503);
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    { branchTitle: 'Recoger a mi hijo de la sala' },
    { branchTitle: 'No recoger el cuarto' },
    { focus: 'Ropa en el suelo. El cesto está roto.' },
    { focus: 'Separar solo fotos claras, excluir fotos borrosas' },
    { focus: 'Ropa en el suelo. El cesto está junto a la puerta.',
      existingStepTitles: ['Poner una prenda del suelo en el cesto'] },
    { branchTitle: 'Responder el correo', existingStepTitles: ['Redactar la respuesta completa'] },
  ])('does not use a context shortcut outside its stated conditions (%j)', async (context) => {
    await handleEvent(event(JSON.stringify({ ...roomRequest, ...context })), deps());

    expect(converse).toHaveBeenCalledOnce();
  });

  it('rejects three titles from the model in single-step mode without retrying', async () => {
    const response = await handleEvent(event(JSON.stringify({ ...request, maxSuggestions: 1 })), deps());
    expect(response.statusCode).toBe(503);
    expect(converse).toHaveBeenCalledOnce();
  });

  it('requests focus for an empty learning root before spending quota', async () => {
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, branchTitle: 'Aprender ajedrez', existingStepTitles: [],
    })), deps());

    expect(response.statusCode).toBe(400);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(converse).not.toHaveBeenCalled();
  });

  it('keeps the legacy three-title request compatible on a learning root', async () => {
    const { maxSuggestions: _maxSuggestions, ...legacy } = knightRequest;
    const response = await handleEvent(event(JSON.stringify({
      ...legacy, branchTitle: 'Aprender ajedrez', existingStepTitles: [],
    })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: titles });
  });

  it('renders a movement exercise from a stated starting point without calling the model', async () => {
    const response = await handleEvent(event(JSON.stringify(knightRequest)), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Marcar dos destinos para un caballo desde d4'] });
    expect(converse).not.toHaveBeenCalled();
  });

  it('uses the object named in the movement goal when several starting points are supplied', async () => {
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, branchTitle: 'Practicar el movimiento de la torre', existingStepTitles: [],
      focus: 'Un caballo en d4. Una torre en f6.',
    })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Marcar dos destinos para una torre desde f6'] });
    expect(converse).not.toHaveBeenCalled();
  });

  it('renders a movement exercise from model-selected anchors in the existing step', async () => {
    converse.mockResolvedValue({ ...modelResponse(), output: { message: { content: [{ text: JSON.stringify({
      kind: 'destinations', subject: 'un caballo', reference: 'd4',
    }) }] } } });

    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, existingStepTitles: ['Ya hay un caballo en d4'],
    })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Marcar dos destinos para un caballo desde d4'] });
    expect(converse).toHaveBeenCalledOnce();
  });

  it.each([
    { suggestions: ['Mover el caballo a f6'] },
    { kind: 'destinations', subject: 'un caballo', reference: 'f6' },
    { kind: 'destinations', subject: 'un caballo', reference: 'd4', answer: 'f6' },
    { kind: 'find', subject: 'caballo en d4 o f6' },
    { kind: 'compare', subject: 'd4', reference: 'd4' },
  ])('withholds an ungrounded or non-exercise model payload (%j)', async (payload) => {
    converse.mockResolvedValue({ ...modelResponse(), output: { message: { content: [{ text: JSON.stringify(payload) }] } } });
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, existingStepTitles: ['Ya hay un caballo en d4'],
    })), deps());

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('f6');
    expect(converse).toHaveBeenCalledOnce();
  });

  it('rejects an exercise that pairs one object with the position of another', async () => {
    converse.mockResolvedValue({ ...modelResponse(), output: { message: { content: [{ text: JSON.stringify({
      kind: 'destinations', subject: 'un caballo', reference: 'f6',
    }) }] } } });
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, existingStepTitles: [], focus: 'Practicar movimiento: un caballo en d4 y una torre en f6.',
    })), deps());

    expect(response.statusCode).toBe(503);
    expect(converse).toHaveBeenCalledOnce();
  });

  it('poses a math exercise using the operands provided by the user', async () => {
    converse.mockResolvedValue({ ...modelResponse(), output: { message: { content: [{ text: JSON.stringify({
      kind: 'compare', subject: '1/2', reference: '3/4',
    }) }] } } });
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, treeTitle: 'Aprender matemáticas', branchTitle: 'Aprender matemáticas',
      existingStepTitles: [], focus: 'Comparar 1/2 y 3/4 sin usar decimales',
    })), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: ['Comparar 1/2 y 3/4 y anotar una diferencia'] });
  });

  it('does not accept a replacement that changes the mathematical notation', async () => {
    converse.mockResolvedValue({ ...modelResponse(), output: { message: { content: [{ text: JSON.stringify({
      kind: 'compare', subject: '22', reference: '3',
    }) }] } } });
    const response = await handleEvent(event(JSON.stringify({
      ...knightRequest, treeTitle: 'Aprender matemáticas', branchTitle: 'Aprender matemáticas',
      existingStepTitles: [], focus: 'Comparar 2² y 3',
    })), deps());

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
    converse.mockResolvedValue(modelResponse([suggestion, ...titles.slice(0, 2)]));
    const body = JSON.stringify({ ...request, language, focus });
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
    const proposed = [suggestion, ...titles.slice(0, 2)];
    converse.mockResolvedValue(modelResponse(proposed));
    const body = JSON.stringify({ ...request, language, focus });
    const response = await handleEvent(event(body), deps());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ suggestions: proposed });
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
