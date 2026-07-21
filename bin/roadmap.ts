import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import {
  assertDeploymentStage,
  bootstrapQualifierFor,
  calculateContractHash,
  RoadmapCiBootstrapStack,
  RoadmapHostingStack,
  RoadmapStack,
} from '../lib/roadmap-stack';

const app = new App();

function requiredStage(): string {
  const value = app.node.tryGetContext('stage');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Missing required CDK context "stage"; pass -c stage=dev|test|prod.');
  }
  return value;
}

function requiredSetting(name: 'AWS_ACCOUNT_ID' | 'HOSTED_ZONE_ID'): string {
  const contextValue = app.node.tryGetContext(name);
  const value = typeof contextValue === 'string' ? contextValue : process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required ${name}; pass -c ${name}=... or set the environment variable.`);
  }
  return value.trim();
}

const stage = requiredStage();
assertDeploymentStage(stage);
const account = requiredSetting('AWS_ACCOUNT_ID');
const hostedZoneId = requiredSetting('HOSTED_ZONE_ID');
if (!/^\d{12}$/.test(account)) {
  throw new Error('AWS_ACCOUNT_ID must contain exactly 12 digits.');
}

const env = { account, region: 'us-east-1' };
const production = stage === 'prod';
const stageSynthesizer = () =>
  new DefaultStackSynthesizer({ qualifier: bootstrapQualifierFor(stage) });

new RoadmapStack(app, `Roadmap-${stage}-Backend`, {
  env,
  stage,
  hostedZoneId,
  contractHash: calculateContractHash(),
  synthesizer: stageSynthesizer(),
  terminationProtection: production,
  description: `RoadMap2U ${stage} serverless backend`,
});

new RoadmapHostingStack(app, `Roadmap-${stage}-Hosting`, {
  env,
  stage,
  hostedZoneId,
  synthesizer: stageSynthesizer(),
  terminationProtection: production,
  description: `RoadMap2U ${stage} private PWA hosting`,
});

new RoadmapCiBootstrapStack(app, 'Roadmap-CiBootstrap', {
  env,
  hostedZoneId,
  githubOwner: 'Toydrum',
  backendRepository: 'roadmap2u-backend',
  frontendRepository: 'RoadMap2U',
  terminationProtection: true,
  description: 'GitHub Actions OIDC provider and stage-selected deployment roles',
});
