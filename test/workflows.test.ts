import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  const path = join(process.cwd(), '.github', 'workflows', name);
  expect(existsSync(path), `Missing workflow ${path}`).toBe(true);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function document(name: string): string {
  const path = join(process.cwd(), 'docs', name);
  expect(existsSync(path), `Missing document ${path}`).toBe(true);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('backend GitHub Actions', () => {
  it('runs reproducible contract, type, test and three-stage synth checks', () => {
    const contents = workflow('ci.yml');
    expect(contents).toContain('pull_request:');
    expect(contents).toContain(
      'npm install --global npm@10.9.8 --ignore-scripts --no-audit --no-fund',
    );
    expect(contents).toContain('test "$(npm --version)" = "10.9.8"');
    expect(contents).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(contents).toContain('npm run contracts:check');
    expect(contents).toContain('npm run typecheck');
    expect(contents).toContain('npm test');
    expect(contents).toContain('npx --no-install cdk synth');
    expect(contents).not.toMatch(/uses:\s+\S+@v\d/);
    for (const stage of ['dev', 'test', 'prod']) {
      expect(contents).toContain(`stage=${stage}`);
    }
  });

  it('deploys only an exact SHA with OIDC and release-marker promotion proof', () => {
    const contents = workflow('deploy.yml');
    expect(contents.match(/id-token: write/g) ?? []).toHaveLength(1);
    expect(contents.indexOf('id-token: write')).toBeGreaterThan(contents.indexOf('\n  deploy:\n'));
    expect(contents).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(contents).toContain('npx --no-install cdk diff');
    expect(contents).toContain('npx --no-install cdk deploy');
    expect(contents).not.toMatch(/uses:\s+\S+@v\d/);
    expect(contents).toContain("vars.AWS_DEPLOY_ENABLED == 'true'");
    expect(contents).toContain('allowed-account-ids: ${{ vars.AWS_ACCOUNT_ID }}');
    expect(contents).toContain('^[0-9a-f]{40}$');
    expect(contents).not.toContain('ref: main');
    expect(contents).toContain("needs.prepare.outputs.operation == 'deploy'");
    expect(contents).toContain('/backend-releases/${SHA}');
    expect(contents).toContain('/backend-release-sha');
    expect(contents).toContain('aws sts get-caller-identity');
    expect(contents).toContain('(.Parameters | length) == 8');
    expect(contents).toContain('Smoke-test protected API and exact CORS allowlist');
    expect(contents).toContain("tr -d '\\r'");
    expect(contents).not.toContain('describe-stacks +');
    expect(contents.indexOf('cdk diff')).toBeLessThan(contents.indexOf('cdk deploy'));
    expect(contents.indexOf('Smoke-test protected API')).toBeLessThan(
      contents.lastIndexOf('/backend-releases/${SHA}'),
    );
  });

  it('supports a manual exact-main dev deploy and enforces exclusive deploy and rollback gates', () => {
    const contents = workflow('deploy.yml');
    expect(contents).toContain('options: [deploy, promote, rollback]');
    expect(contents).toContain('Manual deploy is allowed only for dev');
    expect(contents).toContain('TRIGGER_EVENT: ${{ github.event_name }}');
    expect(contents).toContain("git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'");
    expect(contents).toContain('test "$SHA" = "$(git rev-parse refs/remotes/origin/main)"');
    expect(contents).toContain("vars.AWS_ROLLBACK_ENABLED == 'true'");
    expect(contents).toContain("vars.AWS_ROLLBACK_ENABLED == 'false'");
    expect(contents).toContain("vars.AWS_DEPLOY_ENABLED == 'false'");
    expect(contents).not.toContain("vars.AWS_ROLLBACK_ENABLED != 'true'");
    expect(contents).not.toContain("vars.AWS_DEPLOY_ENABLED != 'true'");
    expect(contents).toContain("needs.prepare.outputs.operation == 'rollback'");
    expect(contents).toContain('AWS_ROLLBACK_ENABLED: ${{ vars.AWS_ROLLBACK_ENABLED }}');
    expect(contents).toContain('Exactly one of AWS_DEPLOY_ENABLED or AWS_ROLLBACK_ENABLED');
  });

  it('admits only absent or deployable stable stacks before deploy and exact success states after deploy', () => {
    const contents = workflow('deploy.yml');
    const preflight = contents.indexOf('Validate pre-deploy CloudFormation states');
    const diff = contents.indexOf('Review CDK diff');
    const deploy = contents.indexOf('Deploy selected stage');
    const postflight = contents.indexOf('Validate deployed stacks and public configuration');

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(diff);
    expect(diff).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(postflight);
    const preflightContents = contents.slice(preflight, diff);
    const postflightContents = contents.slice(postflight);
    expect(preflightContents).toContain(
      'CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE',
    );
    expect(postflightContents).toContain('CREATE_COMPLETE|UPDATE_COMPLETE');
    expect(postflightContents).not.toContain('UPDATE_ROLLBACK_COMPLETE');
    expect(contents).toContain('ValidationError');
    expect(contents).toContain('does not exist');
    expect(contents).not.toContain('[[ "$STATUS" == *_COMPLETE ]]');
  });

  it('keeps deployment behind one stage environment approval', () => {
    const contents = workflow('deploy.yml');
    expect(contents.match(/^\s+environment:/gm) ?? []).toHaveLength(1);
    expect(contents).toContain('environment: ${{ needs.prepare.outputs.stage }}');
  });

  it('publishes an immutable validated backend handoff manifest before release markers', () => {
    const contents = workflow('deploy.yml');
    const smoke = contents.indexOf('Smoke-test protected API and exact CORS allowlist');
    const manifest = contents.indexOf('Publish immutable backend release manifest');
    const marker = contents.lastIndexOf(
      'aws ssm put-parameter --name "/roadmap2u/${STAGE}/backend-releases/${SHA}"',
    );
    const pointer = contents.lastIndexOf(
      'aws ssm put-parameter --name "/roadmap2u/${STAGE}/backend-release-sha"',
    );
    const manifestContents = contents.slice(manifest, marker);

    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(manifest);
    expect(manifest).toBeLessThan(marker);
    expect(marker).toBeLessThan(pointer);
    expect(manifestContents).toContain('/backend-release-manifests/${SHA}');
    expect(manifestContents).toContain('schemaVersion: 1');
    expect(manifestContents).toContain('stage: $stage');
    expect(manifestContents).toContain('backendReleaseSha: $sha');
    expect(manifestContents).toContain('handoff:');
    for (const key of [
      'region',
      'userPoolId',
      'userPoolClientId',
      'apiBaseUrl',
      'frontendBucket',
      'cloudFrontDistributionId',
      'frontendUrl',
      'contractHash',
    ]) {
      expect(manifestContents).toContain(`${key}:`);
    }
    expect(manifestContents).toContain('ParameterNotFound');
    expect(manifestContents).toContain('jq --compact-output --sort-keys');
    expect(manifestContents).not.toContain('--overwrite');
  });

  it('verifies every application log group with the exact stage retention after deploy', () => {
    const contents = workflow('deploy.yml');
    expect(contents).toContain('dev) EXPECTED_LOG_RETENTION=7');
    expect(contents).toContain('test) EXPECTED_LOG_RETENTION=14');
    expect(contents).toContain('prod) EXPECTED_LOG_RETENTION=30');
    for (const group of [
      '/aws/lambda/roadmap-pre-signup-${STAGE}',
      '/aws/lambda/roadmap-post-confirmation-${STAGE}',
      '/aws/lambda/roadmap-router-${STAGE}',
      '/aws/apigateway/roadmap-api-${STAGE}',
    ]) {
      expect(contents).toContain(group);
    }
    expect(contents).toContain('.retentionInDays == $retention');
    expect(contents.indexOf('Deploy selected stage')).toBeLessThan(
      contents.indexOf('Validate application log retention'),
    );
    expect(contents.indexOf('Validate application log retention')).toBeLessThan(
      contents.indexOf('Publish immutable backend release manifest'),
    );
  });

  it('has a manual identity-only OIDC preflight with no checkout or AWS write API', () => {
    const contents = workflow('oidc-preflight.yml');
    expect(contents).toContain('workflow_dispatch:');
    expect(contents).toContain('options: [dev, test, prod, prod-dns-plan, prod-dns-cutover]');
    expect(contents).toContain('permissions: {}');
    expect(contents).toContain('id-token: write');
    expect(contents).toContain("contains(fromJSON('[\"dev\",\"test\",\"prod\"]'), inputs.stage)");
    expect(contents).toContain("if: ${{ inputs.stage == 'prod-dns-plan' }}");
    expect(contents).toContain("if: ${{ inputs.stage == 'prod-dns-cutover' }}");
    expect(contents).toContain('role-to-assume: ${{ vars.AWS_ROLE_ARN }}');
    expect(contents).toContain('role-to-assume: ${{ vars.DNS_PLAN_ROLE_ARN }}');
    expect(contents).toContain('role-to-assume: ${{ vars.DNS_CUTOVER_ROLE_ARN }}');
    expect(contents).toContain('allowed-account-ids: ${{ vars.AWS_ACCOUNT_ID }}');
    expect(
      contents.match(/aws sts get-caller-identity --query Account --output text/g) ?? [],
    ).toHaveLength(3);
    expect(contents).not.toContain('actions/checkout');
    expect(contents).not.toContain('contents: read');
    expect(contents).not.toContain('contents: write');
    expect(contents).not.toMatch(/aws (cloudformation|ssm|route53|s3|lambda|cognito-idp|iam)\b/);
    expect(contents).not.toMatch(/\b(gh|curl)\s/);
    expect(contents).not.toMatch(/uses:\s+\S+@v\d/);
  });

  it('keeps DNS cutover manual, double gated, backed up and reversible', () => {
    const contents = workflow('dns-cutover.yml');
    expect(contents).toContain('workflow_dispatch:');
    expect(contents).not.toContain('push:');
    expect(contents).not.toMatch(/uses:\s+\S+@v\d/);
    expect(contents).toContain("vars.AWS_DEPLOY_ENABLED == 'true'");
    expect(contents).toContain("inputs.operation == 'cutover'");
    expect(contents).toContain("inputs.operation == 'rollback'");
    expect(contents).toContain("vars.AWS_DEPLOY_ENABLED == 'false'");
    expect(contents).toContain("vars.AWS_ROLLBACK_ENABLED == 'true'");
    expect(contents).not.toContain("vars.AWS_ROLLBACK_ENABLED != 'true'");
    expect(contents).toContain("vars.DNS_CUTOVER_ENABLED == 'true'");
    expect(contents).toContain('AWS_ROLLBACK_ENABLED: ${{ vars.AWS_ROLLBACK_ENABLED }}');
    expect(contents).toContain('test "$AWS_ROLLBACK_ENABLED" = "false"');
    expect(contents).toContain('test "$AWS_DEPLOY_ENABLED" = "false"');
    expect(contents).toContain('test "$AWS_ROLLBACK_ENABLED" = "true"');
    expect(contents).toContain('CUTOVER roadmap2u.com');
    expect(contents).toContain('ROLLBACK roadmap2u.com');
    expect(contents).toContain('DNS_CUTOVER_ROLE_ARN');
    expect(contents).toContain('162.241.62.201');
    expect(contents).toContain('/dns-cutover-backup');
    expect(contents).toContain('Action:"DELETE"');
    expect(contents).toContain('.Distribution.Status == "Deployed"');
    expect(contents).toContain('.Distribution.DistributionConfig.IsIPV6Enabled == true');
    expect(contents.indexOf('IsIPV6Enabled == true')).toBeLessThan(
      contents.indexOf('Type:"AAAA"'),
    );
    expect(contents).toContain('dns-plan/zone-before.json');
    expect(contents).toContain('dns-plan/zone-unmanaged-before-normalized.json');
    expect(contents).toContain('apply-result/zone-live-after.json');
    expect(contents).toContain('apply-result/zone-unmanaged-live-after-normalized.json');
    expect(contents).toContain('approved-plan/zone-unmanaged-before-normalized.json');
    expect(contents).toContain('.Name == "roadmap2u.com." or .Name == "www.roadmap2u.com."');
    expect(contents).toContain('.Type == "A" or .Type == "AAAA" or .Type == "CNAME"');
    expect(contents.indexOf('list-resource-record-sets')).toBeLessThan(
      contents.indexOf('change-resource-record-sets'),
    );
  });

  it('plans DNS separately and applies only the immutable reviewed artifact', () => {
    const contents = workflow('dns-cutover.yml');
    const applyMarker = '\n  apply:\n';
    expect(contents).toContain(applyMarker);
    const [plan, apply] = contents.split(applyMarker);

    expect(plan).toContain('environment: prod');
    expect(plan).toContain('DNS_PLAN_ROLE_ARN');
    expect(plan).not.toContain('DNS_CUTOVER_ROLE_ARN');
    expect(plan).toContain('current-records.json');
    expect(plan).toContain('forward-batch.json');
    expect(plan).toContain('rollback-batch.json');
    expect(plan).toContain('plan.md');
    expect(plan).toContain('SHA256SUMS');
    expect(plan).toContain('aws acm describe-certificate');
    expect(plan).toContain('resolver-observations.txt');
    expect(plan).toContain('id: upload-plan');
    expect(plan).not.toContain("&& (Type=='A'");
    expect(plan).not.toContain('change-resource-record-sets');

    expect(apply).toContain('needs: plan');
    expect(apply).toContain('environment: prod-dns-cutover');
    expect(apply).toContain('artifact-ids: ${{ needs.plan.outputs.artifact-id }}');
    expect(apply).toContain('merge-multiple: true');
    expect(apply).toContain('actions: read');
    expect(apply).toContain('/actions/artifacts/$ARTIFACT_ID/zip');
    expect(apply).toContain('sha256sum approved-plan.zip');
    expect(apply).toContain('test "$ACTUAL_ARTIFACT_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST"');
    expect(apply).toContain('sha256sum --check SHA256SUMS');
    expect(apply.indexOf('sha256sum approved-plan.zip')).toBeLessThan(
      apply.indexOf('sha256sum --check SHA256SUMS'),
    );
    expect(apply).toContain('sort_by(.Name,.Type,(.SetIdentifier // ""))');
    expect(apply).toContain('change-resource-record-sets');
    expect(apply).toContain('DNS_CUTOVER_ROLE_ARN');
    expect(apply).not.toContain('DNS_PLAN_ROLE_ARN');
  });

  it('documents immutable OIDC trust, custom bootstrap, Cognito mail and rollback gates', () => {
    const setup = document('github-aws-setup.md');
    const deployRunbook = document(join('runbooks', 'deploy.md'));
    const dnsRunbook = document(join('runbooks', 'dns-cutover.md'));
    const operationsRunbook = document(join('runbooks', 'operations.md'));
    const architecture = document('architecture.md');
    const combined = [setup, deployRunbook, architecture].join('\n');

    expect(setup).toContain(
      'repo:Toydrum@61118847/roadmap2u-backend@1307128632:environment:<stage>',
    );
    expect(setup).toContain('repo:Toydrum@61118847/RoadMap2U@741787733:environment:<stage>');
    expect(setup).toContain('proveedor OIDC existente');
    expect(setup).toContain('BootstraplessSynthesizer');
    expect(setup).toContain('oidc-preflight.yml');
    expect(setup).toContain("'X-GitHub-Api-Version: 2026-03-10'");
    expect(setup).toContain('{"use_default":true,"use_immutable_subject":true}');
    expect(setup).toContain('sub_claim_prefix');
    expect(combined).toContain('AWS_ROLLBACK_ENABLED');
    expect(combined).toContain('HostGator');
    expect(combined).toContain('EmailSendingAccount: COGNITO_DEFAULT');
    expect(combined).toContain('50 correos diarios');
    expect(combined).toContain('sin permisos `ses:*`');
    expect(deployRunbook).toContain('CREATE_COMPLETE');
    expect(deployRunbook).toContain('UPDATE_COMPLETE');
    expect(dnsRunbook).toContain(
      '`AWS_DEPLOY_ENABLED=false`, `AWS_ROLLBACK_ENABLED=true` y `DNS_CUTOVER_ENABLED=true`',
    );
    expect(operationsRunbook).toContain('DELETE SMOKE dev smoke_dev_01');
    expect(operationsRunbook).toContain("'DESTROY dev'");
    expect(operationsRunbook).toContain('reanudable');
    expect(operationsRunbook).toContain('IAM no ofrece una condición');
    expect(operationsRunbook).toContain('broker Lambda');
    expect(setup).not.toContain('no forman parte de esta entrega');
    expect(architecture).not.toContain('deliberadamente **no operativa');
  });
});
