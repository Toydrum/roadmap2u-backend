import { describe, expect, it } from 'vitest';
import { individualPurchaseAdmitted, parsePurchaseAdmission } from '../lambda/billing/admission';

describe('individual purchase audience, independent of existing subscriptions', () => {
  it.each([undefined, null, false, [], {}, { version: 2, mode: 'general', generalApprovalReference: 'approval-2026-10-11' }, { version: 1, mode: 'unknown' }])('closes missing or invalid control %j', (value) => {
    expect(parsePurchaseAdmission(value)).toEqual({ version: 1, mode: 'closed' });
    expect(individualPurchaseAdmitted(value, 'adult-1')).toBe(false);
    expect(individualPurchaseAdmitted(value)).toBe(false);
  });

  it('admits only the exact owners in an explicit cohort; public catalog may show the offer', () => {
    const admission = { version: 1, mode: 'cohort', ownerSubs: ['adult-1', 'adult-2'] };
    expect(parsePurchaseAdmission(admission)).toEqual(admission);
    expect(individualPurchaseAdmitted(admission)).toBe(true);
    expect(individualPurchaseAdmitted(admission, 'adult-1')).toBe(true);
    expect(individualPurchaseAdmitted(admission, 'adult-2')).toBe(true);
    for (const owner of ['adult-3', 'ADULT-1', '', ' adult-1']) expect(individualPurchaseAdmitted(admission, owner)).toBe(false);
  });

  it.each([[], ['adult-1', 'adult-1'], [''], [' adult-1'], ['adult 1'], ['x'.repeat(129)], Array.from({ length: 101 }, (_, i) => `adult-${i}`)])('closes an invalid cohort %j', (ownerSubs) => {
    expect(individualPurchaseAdmitted({ version: 1, mode: 'cohort', ownerSubs }, 'adult-1')).toBe(false);
    expect(individualPurchaseAdmitted({ version: 1, mode: 'cohort', ownerSubs })).toBe(false);
  });

  it.each([undefined, '', ' ', 'draft-v1', 'pending-approval', 'TBD', 'unapproved', 'x'.repeat(257)])('closes general access without its own approved reference %j', (generalApprovalReference) => {
    expect(individualPurchaseAdmitted({ version: 1, mode: 'general', generalApprovalReference }, 'adult-1')).toBe(false);
  });

  it('opens general audience only through its separately named approval; it does not imply buyer eligibility', () => {
    const admission = { version: 1, mode: 'general', generalApprovalReference: 'S6.4-window-2026-10-11-01' };
    expect(individualPurchaseAdmitted(admission, 'adult-1')).toBe(true);
    expect(individualPurchaseAdmitted(admission, 'adult-3')).toBe(true);
    expect(individualPurchaseAdmitted(admission)).toBe(true);
    expect(individualPurchaseAdmitted(admission, '')).toBe(false);
  });

  it.each([
    { version: 1, mode: 'closed', ownerSubs: ['adult-1'] },
    { version: 1, mode: 'cohort', ownerSubs: ['adult-1'], generalApprovalReference: 'S6.4-window-01' },
    { version: 1, mode: 'general', generalApprovalReference: 'S6.4-window-01', ownerSubs: ['adult-1'] },
    { version: 1, mode: 'general', fiscalApprovalReference: 'approved' },
    { version: 1, mode: 'general', generalApprovalReference: 'S6.4-window-01', enabled: true },
  ])('closes conflicting or unknown fields %j', (value) => {
    expect(individualPurchaseAdmitted(value, 'adult-1')).toBe(false);
  });

  it('copies the cohort so later mutation cannot silently broaden an accepted control', () => {
    const ownerSubs = ['adult-1'];
    const parsed = parsePurchaseAdmission({ version: 1, mode: 'cohort', ownerSubs });
    ownerSubs.push('adult-2');
    expect(individualPurchaseAdmitted(parsed, 'adult-2')).toBe(false);
  });
});
