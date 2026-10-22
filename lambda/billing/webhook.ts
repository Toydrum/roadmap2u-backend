import Stripe from 'stripe';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { BillingRepository, StripeEventEnvelope } from './model';
import { loadWebhookConfig, type WebhookConfig } from './config';
import { DynamoBillingRepository } from './dynamo';
import { billingDynamoClient, environment } from './runtime';
import { billingMetric, type BillingMetric } from './metrics';
import { ok, type HttpResponse } from '../http';

interface WebhookEvent { body?: string | null; isBase64Encoded?: boolean; headers: Record<string, string | undefined> }
interface Deps { repository: BillingRepository; config: WebhookConfig; now: () => number; enqueue: (eventId: string) => Promise<void>; metric: (name: BillingMetric, value?: number) => void }
const MAX_BYTES = 256 * 1024;
const response = (status: number) => ({ ...ok({ received: status === 200 }, status), headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export function createWebhookHandler(deps: Deps): (event: WebhookEvent) => Promise<HttpResponse> {
  return async (input) => {
    const encoded = input.body ?? '';
    if (Buffer.byteLength(encoded, 'utf8') > (input.isBase64Encoded ? Math.ceil(MAX_BYTES / 3) * 4 + 4 : MAX_BYTES)) return response(413);
    if (input.isBase64Encoded && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded.length)) return response(400);
    const raw = Buffer.from(encoded, input.isBase64Encoded ? 'base64' : 'utf8');
    if (raw.byteLength > MAX_BYTES) return response(413);
    const signature = Object.entries(input.headers).find(([key]) => key.toLowerCase() === 'stripe-signature')?.[1];
    let event: Stripe.Event;
    try {
      if (!signature) throw new Error();
      event = Stripe.webhooks.constructEvent(raw, signature, deps.config.secret, 300, undefined, deps.now());
      if (event.livemode !== deps.config.liveMode || event.api_version !== deps.config.apiVersion || (event.account !== undefined && event.account !== deps.config.accountId) || !/^evt_[A-Za-z0-9]+$/.test(event.id)) throw new Error();
    } catch { deps.metric('SignatureError'); return response(400); }
    const object = event.data.object as { id?: string; object?: string };
    const now = deps.now();
    const minimal: StripeEventEnvelope = { eventId: event.id, type: event.type, objectId: typeof object.id === 'string' ? object.id : '', objectType: typeof object.object === 'string' ? object.object : '', apiVersion: event.api_version, liveMode: event.livemode, accountId: deps.config.accountId, status: 'pending', attempts: 0, receivedAt: now, nextAttemptAt: now };
    try { await deps.repository.putEvent(minimal); }
    catch { return response(503); }
    // A duplicate may repair the first delivery's failed queue send; the inbox owns dedupe.
    try { await deps.enqueue(event.id); } catch { deps.metric('PendingEventAgeSeconds', 0); }
    return response(200);
  };
}
export async function handler(event: APIGatewayProxyEventV2): Promise<HttpResponse> {
  try {
    const config = await loadWebhookConfig(environment('STRIPE_WEBHOOK_SECRET_PARAMETER'));
    if (config.stage !== environment('STAGE')) throw new Error();
    const repository = new DynamoBillingRepository({ ddb: billingDynamoClient(), table: environment('TABLE_NAME'), accountId: config.accountId, liveMode: config.liveMode, stage: config.stage, financialRetentionPolicy: config.financialRetentionPolicy });
    const sqs = new SQSClient({});
    return await createWebhookHandler({ repository, config, now: Date.now, metric: billingMetric, enqueue: async (eventId) => { await sqs.send(new SendMessageCommand({ QueueUrl: environment('BILLING_EVENT_QUEUE_URL'), MessageBody: JSON.stringify({ eventId }) })); } })(event);
  } catch { billingMetric('ConfigurationError'); return response(503); }
}
