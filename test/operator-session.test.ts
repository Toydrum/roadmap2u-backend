import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let implementation: Record<string, any> = {};
try { implementation = await import(pathToFileURL(join(process.cwd(), 'scripts/lib/operator-session.mjs')).href); }
catch (error: any) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const now = 1_800_000_000_000;
const secrets = { Version: 1, AccessKeyId: 'MEMORY_ACCESS_KEY', SecretAccessKey: 'MEMORY_SECRET_KEY', SessionToken: 'MEMORY_TOKEN', Expiration: new Date(now + 3_600_000).toISOString() };
const identity = (stage = 'dev', purpose = 'family-pilot-operator', account = '765932874577') => ({ Account: account, Arn: `arn:aws:sts::${account}:assumed-role/roadmap2u-${stage}-${purpose}/codex-work-session` });

describe('reusable operator sessions', () => {
  it('defines eleven exact stage profiles sourced from the MFA owner without a PROD fixture', () => {
    expect(implementation.buildOperatorProfiles).toBeTypeOf('function');
    const profiles = implementation.buildOperatorProfiles();
    expect(profiles).toHaveLength(11);
    for (const profile of profiles) {
      expect(profile.durationSeconds).toBe(3_600);
      expect(profile.sourceProfile).toBe('roadmap2u');
      expect(profile.roleArn).toBe(`arn:aws:iam::765932874577:role/roadmap2u/${profile.stage}/operations/${profile.profile}`);
    }
    expect(profiles.some((profile: any) => profile.stage === 'prod' && profile.purpose === 'fixture')).toBe(false);
  });

  it('rejects an unknown stage or PROD fixture before invoking credential resolution', async () => {
    expect(implementation.createOperatorSessionProvider).toBeTypeOf('function');
    const exportCredentials = vi.fn();
    const load = implementation.createOperatorSessionProvider({ exportCredentials, getCallerIdentity: vi.fn(), now: () => now, env: {} });
    await expect(load('qa', 'pilot')).rejects.toThrow();
    await expect(load('prod', 'fixture')).rejects.toThrow();
    expect(exportCredentials).not.toHaveBeenCalled();
  });

  it('uses the cached CLI role credentials and exposes only identity and expiration metadata', async () => {
    expect(implementation.createOperatorSessionProvider).toBeTypeOf('function');
    const exportCredentials = vi.fn(async (_profile: string) => ({ ...secrets }));
    const load = implementation.createOperatorSessionProvider({ exportCredentials, getCallerIdentity: async () => identity(), now: () => now, env: {} });
    const first = await load('dev', 'pilot'); const second = await load('dev', 'pilot');
    expect(exportCredentials.mock.calls.map(([profile]) => profile)).toEqual(['roadmap2u-dev-family-pilot-operator', 'roadmap2u-dev-family-pilot-operator']);
    expect(first.raw.AccessKeyId).toBe(second.raw.AccessKeyId);
    expect(first.raw.Expiration).toEqual(new Date(secrets.Expiration));
    expect(JSON.stringify(first)).not.toMatch(/MEMORY_ACCESS_KEY|MEMORY_SECRET_KEY|MEMORY_TOKEN/);
    expect(first.identity.Arn).toBe(identity().Arn);
  });

  it('accepts CLI renewal for the same role and cache reuse before the renewal margin', async () => {
    let clock = now;
    let current = { ...secrets };
    const load = implementation.createOperatorSessionProvider({ exportCredentials: async () => current,
      getCallerIdentity: async () => identity(), now: () => clock, env: {} });
    await load('dev', 'pilot');
    clock += 40 * 60_000;
    expect((await load('dev', 'pilot')).expiration).toBe(secrets.Expiration);
    clock += 20 * 60_000;
    current = { ...secrets, AccessKeyId: 'RENEWED_MEMORY_ACCESS_KEY', Expiration: new Date(clock + 3_600_000).toISOString() };
    const renewed = await load('dev', 'pilot');
    expect(renewed.identity.Arn).toBe(identity().Arn);
    expect(renewed.raw.AccessKeyId).toBe(current.AccessKeyId);
    expect(JSON.stringify(renewed)).not.toMatch(/RENEWED_MEMORY_ACCESS_KEY|MEMORY_SECRET_KEY|MEMORY_TOKEN/);
  });

  it.each([
    ['another account', identity('dev', 'family-pilot-operator', '111111111111')],
    ['another stage', identity('prod')],
    ['another purpose', identity('dev', 'commercial-flag-operator')],
    ['the owner instead of a role', { Account: '765932874577', Arn: 'arn:aws:iam::765932874577:user/Hector-admin' }],
  ])('refuses %s without substituting administrator credentials', async (_, actual) => {
    expect(implementation.createOperatorSessionProvider).toBeTypeOf('function');
    const load = implementation.createOperatorSessionProvider({ exportCredentials: async () => ({ ...secrets }), getCallerIdentity: async () => actual, now: () => now, env: {} });
    await expect(load('dev', 'pilot')).rejects.toThrow();
  });

  it.each([now + 60_000, now + 7_200_000, now + 43_200_000, NaN])('rejects invalid or insufficient session lifetime %s', async (expiration) => {
    expect(implementation.createOperatorSessionProvider).toBeTypeOf('function');
    const load = implementation.createOperatorSessionProvider({ exportCredentials: async () => ({ ...secrets, Expiration: Number.isFinite(expiration) ? new Date(expiration).toISOString() : 'invalid' }), getCallerIdentity: async () => identity(), now: () => now, env: {} });
    await expect(load('dev', 'pilot')).rejects.toThrow();
  });

  it('rejects ambient AWS credentials before using an explicit operator profile', async () => {
    expect(implementation.createOperatorSessionProvider).toBeTypeOf('function');
    const exportCredentials = vi.fn();
    const load = implementation.createOperatorSessionProvider({ exportCredentials, getCallerIdentity: vi.fn(), now: () => now, env: { AWS_ACCESS_KEY_ID: 'AMBIENT' } });
    await expect(load('dev', 'pilot')).rejects.toThrow(); expect(exportCredentials).not.toHaveBeenCalled();
  });
});
