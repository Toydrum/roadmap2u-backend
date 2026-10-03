import { ApiError } from '@app/api/contracts';
import type { Ctx } from '../authz';
import { GetCommand } from '../db';
import { CommercialFlagsResolver, type FamilyBillingFlags } from './flags';

type FamilyRolloutFlag = keyof Pick<FamilyBillingFlags,
  'familyCreationEnabled' | 'minorLinkingEnabled' | 'minorSocialEnabled'>;
type Gate = FamilyRolloutFlag | 'legacy_blocked';

/** Only new capabilities are gated; reads, privacy, rejection and revocation remain available. */
export function familyRolloutGate(method: string, pattern: string): Gate | null {
  if (method !== 'POST') return null;
  if (pattern === '/family/children' || pattern === '/family/invites' ||
    pattern === '/family/invites/accept') return 'legacy_blocked';
  if (pattern === '/family/minors') return 'familyCreationEnabled';
  if (pattern === '/family/minor-link-codes' ||
    pattern.startsWith('/family/minor-link-requests') ||
    pattern.startsWith('/family/additional-responsible-invitations') ||
    pattern === '/family/transfer-primary-responsibility') return 'minorLinkingEnabled';
  if (pattern === '/social/minor-invite-codes' ||
    pattern.startsWith('/social/minor-friend-requests') &&
    !pattern.endsWith('/reject')) return 'minorSocialEnabled';
  return null;
}

export async function requireFamilyRollout(ctx: Ctx, method: string, pattern: string): Promise<void> {
  const gate = familyRolloutGate(method, pattern);
  if (!gate) return;
  if (gate === 'legacy_blocked') throw new ApiError('CAPABILITY_REQUIRED');
  await requireFamilyRolloutFlag(ctx, gate);
}

export async function requireFamilyRolloutFlag(ctx: Ctx, flag: FamilyRolloutFlag): Promise<void> {
  const resolver = new CommercialFlagsResolver({
    now: ctx.deps.now,
    readItem: async () => {
      const response = await ctx.deps.ddb.send(new GetCommand({
        TableName: ctx.deps.table,
        Key: { pk: 'COMMERCIAL#CONFIG', sk: 'FLAGS' },
        ConsistentRead: true,
      }));
      return response.Item;
    },
    emitMetric: () => {},
  });
  const result = await resolver.resolve();
  if (result.status !== 'available') throw new ApiError('COMMERCIAL_CONFIGURATION_UNAVAILABLE');
  if (!result.flags[flag]) throw new ApiError('CAPABILITY_REQUIRED');
}
