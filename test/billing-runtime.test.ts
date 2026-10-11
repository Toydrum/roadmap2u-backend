import { afterEach, describe, expect, it, vi } from 'vitest';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { COMMERCIAL_FLAGS_ATTRIBUTES } from '../lambda/commercial/flags';
import { config } from './support/billing-fixture';
import { STRIPE_API_VERSION } from '../lambda/billing/model';

afterEach(() => { vi.unstubAllEnvs(); });
describe('deployed billing runtime composition', () => {
  it('reads only permitted commercial attributes so least-privilege IAM does not silently close sales', async () => {
    vi.stubEnv('STAGE', 'dev'); vi.stubEnv('TABLE_NAME', 'roadmap'); vi.stubEnv('STRIPE_CONFIG_PARAMETER', '/roadmap2u/dev/stripe/config');
    const ssm = mockClient(SSMClient), ddb = mockClient(DynamoDBDocumentClient);
    ssm.on(GetParameterCommand).resolves({ Parameter: { Type: 'SecureString', Value: JSON.stringify({ ...config, version: 1, apiVersion: STRIPE_API_VERSION, apiKey: 'sk_test_synthetic', taxRatePercentage: 7.25 }) } });
    ddb.on(GetCommand).resolves({});
    const runtime = await (await import('../lambda/billing/runtime')).createBillingRuntime();
    expect((await runtime.service.catalog()).purchasesEnabled).toBe(false);
    const input = ddb.commandCalls(GetCommand).find((c) => c.args[0].input.Key?.['pk'] === 'COMMERCIAL#CONFIG')!.args[0].input;
    expect(input.ConsistentRead).toBe(true); expect(input.ProjectionExpression).toBeTruthy();
    expect(Object.values(input.ExpressionAttributeNames ?? {}).sort()).toEqual([...COMMERCIAL_FLAGS_ATTRIBUTES].sort());
    ssm.restore(); ddb.restore();
  });
});
