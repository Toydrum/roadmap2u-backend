import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { BillingError, STRIPE_API_VERSION, type BillingConfig } from './model';
import { parsePurchaseAdmission } from './admission';
import { individualBillingPrices } from '../../shared/api/contracts';

export interface PrivateBillingConfig extends BillingConfig { version: 1; apiVersion: typeof STRIPE_API_VERSION; apiKey: string; taxRatePercentage: number }
const required = ['stage', 'accountId', 'productId', 'monthlyPriceId', 'annualPriceId', 'taxRateId', 'portalConfigurationId', 'catalogVersion', 'termsVersion', 'successUrl', 'cancelUrl', 'portalReturnUrl', 'apiKey'] as const;
/** Approval withdrawal closes sales; it must never disable cancellation or financial recovery. */
export function purchasesConfigReady(c: BillingConfig): boolean {
  if (!individualBillingPrices(c.catalogVersion)) return false;
  if (!c.liveMode && ['dev', 'test'].includes(c.stage)) return true;
  return c.liveMode && c.stage === 'prod' && !/draft/i.test(c.termsVersion)
    && [c.fiscalApprovalReference, c.commercialTermsApprovalReference, c.generalCommercialTermsApprovalReference].every((v) => typeof v === 'string' && v.trim().length > 0 && !/draft/i.test(v));
}
export function parsePrivateConfig(value: unknown): PrivateBillingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BillingError('BILLING_PAYMENT_REVIEW');
  const c = value as PrivateBillingConfig;
  if (c.version !== 1 || c.apiVersion !== STRIPE_API_VERSION || !required.every((key) => typeof c[key] === 'string' && c[key].length > 0 && c[key].length < 2048) || !['dev', 'test', 'prod'].includes(c.stage) || typeof c.liveMode !== 'boolean' || c.liveMode !== (c.stage === 'prod') || !new RegExp(`^(sk|rk)_${c.liveMode ? 'live' : 'test'}_`).test(c.apiKey) || !Number.isFinite(c.taxRatePercentage) || c.taxRatePercentage <= 0 || c.taxRatePercentage > 100 || !['es', 'en'].every((l) => /^[a-f0-9]{64}$/.test(c.termsHashes?.[l as 'es' | 'en']) && c.termsUrls?.[l as 'es' | 'en'] === `/subscription-terms?lang=${l}`)) throw new BillingError('BILLING_PAYMENT_REVIEW');
  try {
    const urls = [c.successUrl, c.cancelUrl, c.portalReturnUrl].map((u) => new URL(u));
    if (urls.some((u) => u.protocol !== 'https:' || u.username || u.password || u.hash || u.origin !== urls[0].origin || u.pathname !== '/account/subscription')) throw new Error('invalid return URL');
  } catch { throw new BillingError('BILLING_PAYMENT_REVIEW'); }
  for (const key of ['fiscalApprovalReference', 'commercialTermsApprovalReference', 'generalCommercialTermsApprovalReference'] as const) if (c[key] !== undefined && (typeof c[key] !== 'string' || c[key].length > 2048)) throw new BillingError('BILLING_PAYMENT_REVIEW');
  return { ...c, purchaseAdmission: parsePurchaseAdmission(c.purchaseAdmission) };
}
export async function loadPrivateConfig(parameterName: string, ssm = new SSMClient({})): Promise<PrivateBillingConfig> {
  const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value || result.Parameter?.Type !== 'SecureString' || Buffer.byteLength(value) > 32_768) throw new BillingError('BILLING_PAYMENT_REVIEW');
  try { return parsePrivateConfig(JSON.parse(value)); } catch { throw new BillingError('BILLING_PAYMENT_REVIEW'); }
}
export interface WebhookConfig { secret: string; accountId: string; liveMode: boolean; stage: string; apiVersion: typeof STRIPE_API_VERSION }
export async function loadWebhookConfig(parameterName: string, ssm = new SSMClient({})): Promise<WebhookConfig> {
  const result = await ssm.send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }));
  try {
    if (result.Parameter?.Type !== 'SecureString') throw new Error();
    const c = JSON.parse(result.Parameter?.Value ?? '') as WebhookConfig;
    if (!c.secret.startsWith('whsec_') || !/^acct_[A-Za-z0-9]+$/.test(c.accountId) || typeof c.liveMode !== 'boolean' || c.apiVersion !== STRIPE_API_VERSION || !['dev', 'test', 'prod'].includes(c.stage) || c.liveMode !== (c.stage === 'prod')) throw new Error();
    return c;
  } catch { throw new BillingError('BILLING_PAYMENT_REVIEW'); }
}
