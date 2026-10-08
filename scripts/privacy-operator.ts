import { readFileSync } from 'node:fs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  buildPrivacyOperatorPlan,
  confirmPrivacyOperatorPlan,
  executePrivacyOperatorPlan,
  constrainPrivacyOperatorReads,
} from '../lambda/privacy/operator';

async function main() {
  const options = new Map<string, string | boolean>();
  const allowed = new Set(['stage', 'plan', 'profile', 'apply', 'confirm-stage', 'confirm-hash']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(name) || options.has(name))
      throw new Error('Invalid or duplicate option');
    const value = name === 'apply' ? true : args[++i];
    if (!value || (typeof value === 'string' && value.startsWith('--')))
      throw new Error('Missing option value');
    options.set(name, value);
  }
  if (typeof options.get('plan') !== 'string' || typeof options.get('stage') !== 'string')
    throw new Error('Use --stage and --plan; default is an offline preview');
  const plan = buildPrivacyOperatorPlan(
    options.get('stage') as string,
    JSON.parse(readFileSync(options.get('plan') as string, 'utf8')),
  );
  process.stdout.write(
    `${JSON.stringify({ stage: plan.stage, action: plan.action, dryRunHash: plan.hash, applied: false })}\n`,
  );
  if (!options.has('apply')) return;
  confirmPrivacyOperatorPlan(
    plan,
    options.get('confirm-stage') as string,
    options.get('confirm-hash') as string,
  );
  const profile = options.get('profile');
  if (
    profile !== undefined &&
    (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(profile))
  )
    throw new Error('Invalid profile');
  const credentials = defaultProvider({ profile: profile as string | undefined });
  const config = { region: 'us-east-1', credentials };
  const identity = await new STSClient(config).send(new GetCallerIdentityCommand({}));
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    marshallOptions: { removeUndefinedValues: true },
  });
  constrainPrivacyOperatorReads(ddb, plan.table);
  await executePrivacyOperatorPlan(
    plan,
    {
      ddb,
      table: plan.table,
      privacyTable: plan.privacyTable,
      cognito: new CognitoIdentityProviderClient(config),
      userPoolId: '',
      now: Date.now,
    },
    identity,
  );
  process.stdout.write(
    `${JSON.stringify({ stage: plan.stage, action: plan.action, hash: plan.hash, applied: true })}\n`,
  );
}
main().catch((error) => {
  process.stderr.write(`${error?.code ?? 'privacy_operator_failed'}\n`);
  process.exitCode = 1;
});
