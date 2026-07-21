import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function workflow(name: string): string {
  const path = join(process.cwd(), '.github', 'workflows', name);
  expect(existsSync(path), `Missing workflow ${path}`).toBe(true);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('backend GitHub Actions', () => {
  it('runs reproducible contract, type, test and three-stage synth checks', () => {
    const contents = workflow('ci.yml');
    expect(contents).toContain('pull_request:');
    expect(contents).toContain('npm ci');
    expect(contents).toContain('npm run contracts:check');
    expect(contents).toContain('npm run typecheck');
    expect(contents).toContain('npm test');
    for (const stage of ['dev', 'test', 'prod']) {
      expect(contents).toContain(`stage=${stage}`);
    }
  });

  it('deploys only an exact SHA with OIDC and release-marker promotion proof', () => {
    const contents = workflow('deploy.yml');
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

  it('keeps DNS cutover manual, double gated, backed up and reversible', () => {
    const contents = workflow('dns-cutover.yml');
    expect(contents).toContain('workflow_dispatch:');
    expect(contents).not.toContain('push:');
    expect(contents).toContain("vars.AWS_DEPLOY_ENABLED == 'true'");
    expect(contents).toContain("vars.DNS_CUTOVER_ENABLED == 'true'");
    expect(contents).toContain('CUTOVER roadmap2u.com');
    expect(contents).toContain('ROLLBACK roadmap2u.com');
    expect(contents).toContain('DNS_CUTOVER_ROLE_ARN');
    expect(contents).toContain('162.241.62.201');
    expect(contents).toContain('/dns-cutover-backup');
    expect(contents).toContain('Action:"DELETE"');
    expect(contents).toContain('.Distribution.Status == "Deployed"');
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
    expect(apply).toContain('sha256sum --check SHA256SUMS');
    expect(apply).toContain('sort_by(.Name,.Type,(.SetIdentifier // ""))');
    expect(apply).toContain('change-resource-record-sets');
    expect(apply).toContain('DNS_CUTOVER_ROLE_ARN');
    expect(apply).not.toContain('DNS_PLAN_ROLE_ARN');
  });
});
