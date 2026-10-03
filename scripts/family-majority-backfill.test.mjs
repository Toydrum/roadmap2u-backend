import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { majorityBackfillTransaction, planMajorityBackfill } from './family-majority-backfill.mjs';

const now = Date.parse('2027-01-01T00:00:00.000Z');
const profile = (id, majorityAt, extra = {}) => ({ pk: `USER#${id}`,
  sk: 'PROFILE', userId: id, accountType: 'minor', status: 'active',
  ...(majorityAt ? { majorityAt } : {}), ...extra });

describe('family majority index backfill', () => {
  it('separates missing declarations, due minors, indexed rows and drift', () => {
    const plan = planMajorityBackfill([
      profile('minor-a', '2026-12-31'), profile('minor-b', '2030-01-01'),
      profile('minor-c', null),
      profile('minor-d', '2030-01-01', { gsi2pk: 'FAMILY#MAJORITY',
        gsi2sk: '2030-01-01#minor-d' }),
      profile('minor-e', '2030-01-01', { gsi2pk: 'OTHER' }),
      profile('minor-f', '2030-01-01', { status: 'closing' }),
    ], now);
    assert.deepEqual(plan.totals, { activeMinors: 5, missingDeclaration: 1,
      indexed: 1, candidates: 2, indexDrift: 1, alreadyDue: 1 });
    assert.deepEqual(plan.candidates.map((item) => item.accountId), ['minor-a', 'minor-b']);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  });

  it('writes the sparse marker with exact profile and closure checks plus audit', () => {
    const candidate = { accountId: 'minor-a', majorityAt: '2030-01-01',
      indexSk: '2030-01-01#minor-a' };
    const [update, closure, audit] = majorityBackfillTransaction(candidate, 'dev', now,
      'request-1').input.TransactItems;
    assert.equal(update.Update.Key.pk, 'USER#minor-a');
    assert.match(update.Update.ConditionExpression, /majorityAt = :majorityAt/);
    assert.match(update.Update.ConditionExpression, /attribute_not_exists\(gsi2pk\)/);
    assert.equal(closure.ConditionCheck.Key.pk, 'ACCOUNT_CLOSURE#minor-a');
    assert.equal(audit.Put.TableName, 'roadmap-access-audit-dev');
    assert.equal(audit.Put.Item.action, 'majority_index_backfill');
  });
});
