import { describe, expect, it, vi } from 'vitest';
import { buildFamilyPilotRequest, runFamilyPilotCli } from '../scripts/family-pilot.mjs';

const ARGS = [
  '--stage', 'dev', '--url', 'https://example123.lambda-url.us-east-1.on.aws/',
  '--adult-id', 'adult-invited', '--household-id', 'hh_abc',
  '--expected-household-revision', '1', '--expected-entitlement-revision', '0',
  '--command-id', '9c09f76b-246a-4f0d-a188-8ba97f7f518d',
  '--reason', 'invited_household',
];

describe('family pilot CLI', () => {
  it('requires an exact stage, account, expected revisions, and repeatable command ID', () => {
    expect(buildFamilyPilotRequest('grant', ARGS).body).toMatchObject({
      command: 'grant', stage: 'dev', adultId: 'adult-invited',
      expectedEntitlementRevision: 0,
    });
    expect(() => buildFamilyPilotRequest('grant', ARGS.filter((value, index) =>
      index !== ARGS.indexOf('--command-id') && index !== ARGS.indexOf('--command-id') + 1,
    ))).toThrow(/command-id/);
    expect(() => buildFamilyPilotRequest('grant', [
      ...ARGS.slice(0, 1), 'staging', ...ARGS.slice(2),
    ])).toThrow();
  });

  it('only applies after the dry-run hash and exact operator role agree', async () => {
    const request = buildFamilyPilotRequest('grant', ARGS);
    const fetchRequest = vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ participantCount: 1, idempotent: false }) }));
    const getCredentials = vi.fn(async () => ({ AccessKeyId: 'a', SecretAccessKey: 'b' }));
    const role = 'arn:aws:sts::765932874577:assumed-role/roadmap2u-dev-family-pilot-operator/session';
    const deps = { write: vi.fn(), runAwsJson: () => ({ Account: '765932874577', Arn: role }),
      getCredentials, fetchRequest };
    expect((await runFamilyPilotCli('grant', ARGS, deps)).applied).toBe(false);
    expect(fetchRequest).not.toHaveBeenCalled();
    await expect(runFamilyPilotCli('grant', [...ARGS, '--apply', '--confirm-stage', 'dev',
      '--confirm-hash', '0'.repeat(64)], deps)).rejects.toThrow(/Confirmation/);
    expect(fetchRequest).not.toHaveBeenCalled();
    await runFamilyPilotCli('grant', [...ARGS, '--apply', '--confirm-stage', 'dev',
      '--confirm-hash', request.hash], deps);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });
});
