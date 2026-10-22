/** Digest of docs/financial-retention-policy.md encoded as UTF-8 with LF line endings. */
export const FINANCIAL_RETENTION_POLICY = Object.freeze({
  version: 'mx-financial-2026-10-22-v1',
  documentSha256: 'c5457b9422ab4dd354bd732bf965f883ca23e7908c5dd0bb8f422920e436e72a',
});

export interface FinancialRetentionPolicyBinding {
  version: string;
  documentSha256: string;
  approvalReference: string;
  status: 'approved' | 'withdrawn';
}

function recognizedPolicyBinding(value: unknown): value is FinancialRetentionPolicyBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return Object.keys(p).sort().join(',') === 'approvalReference,documentSha256,status,version'
    && p['version'] === FINANCIAL_RETENTION_POLICY.version
    && p['documentSha256'] === FINANCIAL_RETENTION_POLICY.documentSha256
    && (p['status'] === 'approved' || p['status'] === 'withdrawn')
    && typeof p['approvalReference'] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(p['approvalReference'])
    && !/draft/i.test(p['approvalReference']);
}

/** Invalid or withdrawn approval closes purchases, without disabling financial recovery. */
export function financialRetentionPolicyReady(value: unknown): value is FinancialRetentionPolicyBinding {
  return recognizedPolicyBinding(value) && value.status === 'approved';
}

const draft = Object.freeze({ retentionScope: 'commercial', retentionPolicyVersion: 'financial-v1-draft', retentionStatus: 'pending_policy_approval' });

export function financialRetentionMetadata(value: unknown, stage: string, liveMode: boolean) {
  // Historical test fixtures retain their original policy; no retrospective relabelling.
  // A sales approval withdrawal does not revoke the policy governing existing obligations.
  if (stage !== 'prod' || !liveMode || !recognizedPolicyBinding(value)) return draft;
  return {
    retentionScope: 'commercial',
    retentionPolicyVersion: value.version,
    retentionPolicySha256: value.documentSha256,
    retentionApprovalReference: value.approvalReference,
    retentionStatus: 'classification_required',
  };
}
