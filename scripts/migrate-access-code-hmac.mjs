import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  DescribeParametersCommand,
  GetParameterCommand,
  GetResourcePoliciesCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  generateAccessCodeHmacMaterial,
  runAccessCodeHmacMigrationCli,
} from './lib/access-code-hmac-migration-cli.mjs';
import { pathToFileURL } from 'node:url';

const REGION = 'us-east-1';

export function createHardenedCredentialProvider({ requestHandler } = {}) {
  return defaultProvider({
    clientConfig: {
      region: REGION,
      ignoreConfiguredEndpointUrls: true,
      ...(requestHandler ? { requestHandler } : {}),
    },
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  write = console.log,
} = {}) {
  if (argv[0] === 'apply' && !process.stdin.isTTY) {
    throw new Error('apply requires an interactive terminal');
  }
  const credentials = createHardenedCredentialProvider();
  const sts = new STSClient({
    region: REGION,
    ignoreConfiguredEndpointUrls: true,
    credentials,
  });
  const secrets = new SecretsManagerClient({
    region: REGION,
    ignoreConfiguredEndpointUrls: true,
    credentials,
  });
  const ssm = new SSMClient({
    region: REGION,
    ignoreConfiguredEndpointUrls: true,
    credentials,
  });
  try {
    return await runAccessCodeHmacMigrationCli({
      argv,
      env,
      write,
      getCallerIdentity: (input) => sts.send(new GetCallerIdentityCommand(input)),
      describeSecret: (input) => secrets.send(new DescribeSecretCommand(input)),
      getSecretValue: (input) => secrets.send(new GetSecretValueCommand(input)),
      describeParameters: (input) => ssm.send(new DescribeParametersCommand(input)),
      getResourcePolicies: (input) => ssm.send(new GetResourcePoliciesCommand(input)),
      getParameter: (input) => ssm.send(new GetParameterCommand(input)),
      putParameter: (input) => ssm.send(new PutParameterCommand(input)),
      generateSecretMaterial: generateAccessCodeHmacMaterial,
    });
  } finally {
    sts.destroy();
    secrets.destroy();
    ssm.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
