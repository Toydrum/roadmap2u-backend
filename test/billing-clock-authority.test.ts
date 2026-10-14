import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { AUTH_NOW, authorityFixture, cleanupAuthorityFixtures } from './support/clock-authority-fixture';

afterAll(cleanupAuthorityFixtures);
async function setup(stage = 'dev', phase: 'install' | 'advance_fence' | 'ready' | 'refresh' = 'install') {
  const f = await authorityFixture(stage, phase);
  expect(f.api.verifyClockCallerAuthority, 'Source/receipt verifier is missing').toBeTypeOf('function');
  return f;
}
describe('native Git and in-memory human receipt binding', () => {
  it.each(['dev', 'test'])('binds reviewed %s bytes, the running source and a fresh exact receipt', async stage => {
    const f = await setup(stage), result = await f.api.verifyClockCallerAuthority(f.options());
    expect(result).toMatchObject({ stage, sourceSha: f.sourceSha, operationId: f.manifest.operationId,
      sourceShaVerified: true, authorizationReceiptBound: true, stackOwnershipVerified: false, physicalExecutionAllowed: false });
    expect(JSON.stringify(result)).not.toContain('credentials');
  });
  it.each(['consumed', 'answer', 'hash', 'future', 'expired', 'long_window', 'call', 'source', 'extra', 'root'] as const)(
    'rejects receipt %s without granting an authority object', async fault => {
      const f = await setup();
      if (fault === 'consumed') f.receipt.consumed = true;
      if (fault === 'answer') f.receipt.answer = 'Autorizo';
      if (fault === 'hash') f.receipt.manifestSha256 = 'a'.repeat(64);
      if (fault === 'future') f.receipt.issuedAt = AUTH_NOW + 1;
      if (fault === 'expired') f.receipt.expiresAt = AUTH_NOW;
      if (fault === 'long_window') f.receipt.expiresAt = f.receipt.issuedAt + 900001;
      if (fault === 'call') f.receipt.callId = 'unknown';
      if (fault === 'source') f.receipt.source = 'automatic_goal_continuation';
      if (fault === 'extra') f.receipt.physicalAuthorizationChecked = true;
      if (fault === 'root') f.receipt.approvedRootCommit = 'a'.repeat(40);
      await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
    });
  it.each(['prod', 'live', 'historical', 'account', 'region', 'table', 'stack', 'physical', 'duplicate', 'phase', 'secret'] as const)(
    'rejects reviewed manifest %s even with a matching receipt', async fault => {
      const f = await setup(), m = f.manifest;
      if (fault === 'prod') m.clock.scope.stage = 'prod';
      if (fault === 'live') m.clock.scope.liveMode = true;
      if (fault === 'historical') { m.clock.ownerSub = 'e4282408-f0f1-70b2-b5ef-b9ddb80599e7'; m.clock.scope.fixtures[0].ownerSub = m.clock.ownerSub; }
      if (fault === 'account') m.storage.awsAccountId = '111111111111';
      if (fault === 'region') m.storage.region = 'eu-west-1';
      if (fault === 'table') m.storage.privacyTableName = 'roadmap-privacy-prod';
      if (fault === 'stack') m.cloudformation.stackId = m.cloudformation.stackId.replace('Roadmap-dev-Backend', 'Roadmap-prod-Backend');
      if (fault === 'physical') m.cloudformation.resources[0].physicalId = 'roadmap-prod';
      if (fault === 'duplicate') m.cloudformation.resources[1].logicalId = m.cloudformation.resources[0].logicalId;
      if (fault === 'phase') m.phase = 'refund';
      if (fault === 'secret') m.apiKey = 'synthetic-private-value';
      f.freezeReview(); await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
    });
  it('rejects changed approved bytes even if the path remains regular', async () => {
    const f = await setup(); writeFileSync(f.reviewRoot + '/reports/clock-manifest.json', f.options().manifestRaw + ' ');
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('rejects an executing module changed after its approved Git source commit', async () => {
    const f = await setup(); writeFileSync(f.bundle, readFileSync(f.bundle, 'utf8') + '\n// unreviewed change\n');
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('rejects an unexpected remote for the verified source', async () => {
    const f = await setup(); f.git(f.sourceRoot, ['remote', 'set-url', 'origin', 'https://example.invalid/other.git']);
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('rejects a different source root even when it contains the claimed commit', async () => {
    const f = await setup(), options = f.options(); options.sourceRoot = f.reviewRoot;
    await expect(f.api.verifyClockCallerAuthority(options)).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it.each(['../outside.json', '/reports/clock-manifest.json', 'reports\\clock-manifest.json', 'reports/../clock-manifest.json'])(
    'rejects escaping or ambiguous reviewed path %s', async manifestPath => {
      const f = await setup(); await expect(f.api.verifyClockCallerAuthority({ ...f.options(), manifestPath })).rejects.toThrow(/^CLOCK_AUTHORITY_/);
    });
  it('rejects replacement of the current review branch with an unrelated commit', async () => {
    const f = await setup(); f.git(f.reviewRoot, ['checkout', '--orphan', 'unrelated']);
    f.git(f.reviewRoot, ['commit', '--allow-empty', '-qm', 'Unrelated review history']);
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it.each(['install', 'advance_fence', 'ready', 'refresh'] as const)('binds the real %s preparer and exact private request digest', async phase => {
    const f = await setup('dev', phase), proof = await f.api.verifyClockCallerAuthority(f.options());
    expect(proof).toMatchObject({ requestSha256: f.manifest.requestSha256, phase, physicalExecutionAllowed: false });
    const plan = f.api.readClockCallerPlan(proof, AUTH_NOW);
    expect(plan.intent.phase).toBe(phase); expect(plan.intent.sourceSha).toBe(f.sourceSha);
    expect(proof.transactionSha256).toBe(plan.intent.transactionSha256);
    expect(JSON.stringify(proof)).not.toContain('in-memory-only');
  });
  it('rejects modified request bytes with the original reviewed digest', async () => {
    const f = await setup();
    await expect(f.api.verifyClockCallerAuthority({ ...f.options(), requestRaw: f.options().requestRaw + ' ' })).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('rejects a different advance target even when the new request digest was reviewed', async () => {
    const f = await setup('dev', 'advance_fence'); f.request.targetFrozenTimeSeconds += 86400; f.freezeReview();
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('rejects an unreviewed operation substituted into a newly hashed request', async () => {
    const f = await setup(); f.request.operationId = 'different_clock_operation'; f.freezeReview();
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
  it('preserves the real business rejection for a minor inside the private request', async () => {
    const f = await setup(); f.request.snapshot.profile.accountType = 'minor'; f.freezeReview();
    await expect(f.api.verifyClockCallerAuthority(f.options())).rejects.toThrow(/^CLOCK_AUTHORITY_/);
  });
});
