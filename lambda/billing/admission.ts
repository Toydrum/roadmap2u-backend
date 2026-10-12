export type PurchaseAdmission =
  | { readonly version: 1; readonly mode: 'closed' }
  | { readonly version: 1; readonly mode: 'cohort'; readonly ownerSubs: readonly string[] }
  | { readonly version: 1; readonly mode: 'general'; readonly generalApprovalReference: string };

const CLOSED: PurchaseAdmission = Object.freeze({ version: 1, mode: 'closed' });
const ownerIdentifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);

/** Private, versioned sales control. Invalid configuration closes new purchases. */
export function parsePurchaseAdmission(value: unknown): PurchaseAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return CLOSED;
  const config = value as Record<string, unknown>;
  if (config.version !== 1) return CLOSED;
  const exactKeys = (keys: readonly string[]) => Object.keys(config).length === keys.length
    && keys.every((key) => Object.hasOwn(config, key));
  if (config.mode === 'closed' && exactKeys(['version', 'mode'])) return CLOSED;
  if (config.mode === 'cohort' && exactKeys(['version', 'mode', 'ownerSubs'])) {
    const owners = config.ownerSubs;
    if (!Array.isArray(owners) || owners.length < 1 || owners.length > 100
      || !owners.every(ownerIdentifier) || new Set(owners).size !== owners.length) return CLOSED;
    return Object.freeze({ version: 1, mode: 'cohort', ownerSubs: Object.freeze([...owners]) });
  }
  if (config.mode === 'general' && exactKeys(['version', 'mode', 'generalApprovalReference'])) {
    const reference = config.generalApprovalReference;
    if (typeof reference !== 'string' || !reference || reference !== reference.trim() || reference.length > 256
      || /\b(draft|pending|tbd|unapproved)\b/i.test(reference)) return CLOSED;
    return Object.freeze({ version: 1, mode: 'general', generalApprovalReference: reference });
  }
  return CLOSED;
}

/** Omit ownerSub only for the public offer; authenticated callers must pass their subject. */
export function individualPurchaseAdmitted(admission: unknown, ownerSub?: string): boolean {
  const parsed = parsePurchaseAdmission(admission);
  if (parsed.mode === 'closed' || (ownerSub !== undefined && !ownerIdentifier(ownerSub))) return false;
  if (ownerSub === undefined || parsed.mode === 'general') return true;
  return parsed.ownerSubs.includes(ownerSub);
}
