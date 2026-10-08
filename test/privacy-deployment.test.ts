import { describe, expect, it } from 'vitest';
import { resolvePrivacyDeployment } from '../scripts/privacy-deployment.mjs';

const release = {
  Parameters: {
    AdultPrivacyMode: { AllowedValues: ['off', 'enforce'] },
    PrivateAdolescentMode: { AllowedValues: ['off', 'enforce'] },
  },
};
const current = (adult = 'off', adolescent = 'off') => ({
  Parameters: [
    { ParameterKey: 'AdultPrivacyMode', ParameterValue: adult },
    { ParameterKey: 'PrivateAdolescentMode', ParameterValue: adolescent },
  ],
});
const resolve = (overrides: Record<string, unknown> = {}) =>
  resolvePrivacyDeployment({
    stage: 'dev',
    operation: 'deploy',
    adult: 'keep',
    adolescent: 'keep',
    releaseTemplate: release,
    currentStack: current(),
    ...overrides,
  });
describe('privacy deployment controls', () => {
  it('installs a compatible first release with both modes off and no implicit activation', () => {
    expect(resolve({ currentStack: { Parameters: [] } })).toEqual({
      supported: true,
      expected: { adult: 'off', adolescent: 'off' },
      parameters: [],
    });
  });
  it('keeps existing enforcement on a normal release and rollback', () => {
    expect(resolve({ currentStack: current('enforce', 'enforce'), operation: 'rollback' })).toEqual(
      { supported: true, expected: { adult: 'enforce', adolescent: 'enforce' }, parameters: [] },
    );
  });
  it.each(['dev', 'test', 'prod'])('allows an explicit ordered activation in %s', (stage) => {
    const result = resolve({
      stage,
      operation: stage === 'dev' ? 'deploy' : 'promote',
      adult: 'enforce',
      adolescent: 'enforce',
    });
    expect(result.parameters).toEqual([
      '--parameters',
      `Roadmap-${stage}-Backend:AdultPrivacyMode=enforce`,
      '--parameters',
      `Roadmap-${stage}-Backend:PrivateAdolescentMode=enforce`,
    ]);
  });
  it('rejects adolescents while adult privacy is off, including keep resolving to off', () => {
    expect(() => resolve({ adolescent: 'enforce' })).toThrow(/require adult/);
    expect(() => resolve({ currentStack: current('enforce', 'enforce'), adult: 'off' })).toThrow(
      /require adult/,
    );
  });
  it('allows disabling both explicitly while preserving the privacy-capable release', () => {
    expect(
      resolve({ currentStack: current('enforce', 'enforce'), adult: 'off', adolescent: 'off' })
        .expected,
    ).toEqual({ adult: 'off', adolescent: 'off' });
  });
  it('rejects a rollback that also changes privacy modes', () => {
    expect(() => resolve({ operation: 'rollback', adult: 'off' })).toThrow(/rollback/);
  });
  it('rejects legacy rollback even after modes were disabled, protecting retained private accounts', () => {
    expect(() => resolve({ releaseTemplate: {}, operation: 'rollback' })).toThrow(
      /without privacy controls/,
    );
    expect(() =>
      resolve({ releaseTemplate: {}, currentStack: current('enforce', 'enforce') }),
    ).toThrow(/without privacy controls/);
  });
  it('permits only the original legacy release when no privacy installation exists', () => {
    expect(resolve({ releaseTemplate: {}, currentStack: { Parameters: [] } }).supported).toBe(
      false,
    );
    expect(() =>
      resolve({ releaseTemplate: {}, currentStack: { Parameters: [] }, adult: 'enforce' }),
    ).toThrow(/without privacy controls/);
  });
  it.each(['ENFORCE', 'enforce\n', '--parameters', '$(anything)', ''])(
    'rejects malformed explicit mode %j',
    (adult) => {
      expect(() => resolve({ adult })).toThrow(/mode/);
    },
  );
  it('rejects inconsistent current parameters and an unknown current value', () => {
    expect(() =>
      resolve({ currentStack: { Parameters: current().Parameters.slice(0, 1) } }),
    ).toThrow(/incomplete/);
    expect(() => resolve({ currentStack: current('shadow') })).toThrow(/current/);
  });
  it('rejects unsupported stage or operation before constructing any shell arguments', () => {
    expect(() => resolve({ stage: 'prod\n' })).toThrow(/stage/);
    expect(() => resolve({ operation: 'activate' })).toThrow(/operation/);
  });
});
