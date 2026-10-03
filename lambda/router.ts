import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  Context,
} from 'aws-lambda';
import { ApiError } from '@app/api/contracts';
import { Ctx, resolveCaller } from './authz';
import { Deps, realDeps } from './db';
import { HttpResponse, errorResponse, ok, parseJsonBody } from './http';
import * as me from './handlers/me';
import * as family from './handlers/family';
import * as household from './handlers/household';
import { getFamilyInbox } from './family/inbox';
import * as friends from './handlers/friends';
import * as social from './handlers/social';
import * as forests from './handlers/forests';
import * as sync from './handlers/sync';
import { instrumentHandler } from './observability';
import { requireFamilyRollout } from './commercial/family-rollout';

/**
 * The single router behind `/v1/{proxy+}`. CORS preflight returns before auth;
 * application routes arrive after the JWT authorizer has verified the idToken,
 * resolve the caller from the TABLE (authz truth), and dispatch. Route patterns
 * mirror API_PATHS in contracts.ts 1:1; test/routes.test.ts enforces parity.
 */

type Handler = (ctx: Ctx, params: Record<string, string>, body: unknown) => Promise<unknown>;

interface Route {
  method: string;
  pattern: string; // '/family/children/:id/reset-password'
  handler: Handler;
  status?: number;
}

export const ROUTES: Route[] = [
  { method: 'GET', pattern: '/me', handler: (c) => me.getMe(c) },
  { method: 'PATCH', pattern: '/me', handler: (c, _p, b) => me.patchMe(c, b as { displayName?: string }) },

  { method: 'POST', pattern: '/family/children', handler: (c, _p, b) => family.createChild(c, b as never), status: 201 },
  { method: 'POST', pattern: '/family/children/:id/reset-password', handler: (c, p) => family.resetChildPassword(c, p['id']) },
  { method: 'PATCH', pattern: '/family/children/:id', handler: (c, p, b) => family.patchChild(c, p['id'], b as never) },
  { method: 'GET', pattern: '/family/children/:id/export', handler: (c, p) => family.exportChild(c, p['id']) },
  { method: 'DELETE', pattern: '/family/children/:id', handler: (c, p) => family.deleteChild(c, p['id']), status: 204 },
  { method: 'DELETE', pattern: '/family/links/:linkId', handler: (c, p) => family.deleteFamilyLink(c, p['linkId']), status: 204 },
  { method: 'POST', pattern: '/family/invites', handler: (c, _p, b) => family.createFamilyInvite(c, b as never), status: 201 },
  { method: 'POST', pattern: '/family/invites/accept', handler: (c, _p, b) => family.acceptFamilyInvite(c, b as never) },
  { method: 'DELETE', pattern: '/family/invites/:code', handler: (c, p) => family.revokeFamilyInvite(c, p['code']), status: 204 },
  { method: 'GET', pattern: '/family/children/:id/friends', handler: (c, p) => family.listChildFriends(c, p['id']) },
  { method: 'DELETE', pattern: '/family/children/:id/friends/:fid', handler: (c, p) => family.removeChildFriendship(c, p['id'], p['fid']), status: 204 },
  { method: 'DELETE', pattern: '/family/children/:id/requests/:rid', handler: (c, p) => family.cancelChildRequest(c, p['id'], p['rid']), status: 204 },

  { method: 'GET', pattern: '/family/household', handler: (c) => household.getHousehold(c) },
  { method: 'GET', pattern: '/family/inbox', handler: (c, p) => getFamilyInbox(c, p['cursor']) },
  { method: 'POST', pattern: '/family/minors', handler: (c, _p, b) => household.createMinor(c, b), status: 201 },
  { method: 'POST', pattern: '/family/minor-link-codes', handler: (c, _p, b) => household.createMinorLinkCode(c, b), status: 201 },
  { method: 'POST', pattern: '/family/minor-link-requests', handler: (c, _p, b) => household.createMinorLinkRequest(c, b), status: 201 },
  { method: 'POST', pattern: '/family/minor-link-requests/:id/approve', handler: (c, p, b) => household.approveMinorLinkRequest(c, p['id'], b) },
  { method: 'POST', pattern: '/family/minor-link-requests/:id/accept', handler: (c, p, b) => household.acceptMinorLinkRequest(c, p['id'], b) },
  { method: 'POST', pattern: '/family/additional-responsible-invitations', handler: (c, _p, b) => household.inviteAdditionalResponsible(c, b), status: 201 },
  { method: 'POST', pattern: '/family/additional-responsible-invitations/:id/accept', handler: (c, p, b) => household.acceptAdditionalResponsible(c, p['id'], b) },
  { method: 'PUT', pattern: '/family/additional-responsible/scope', handler: (c, _p, b) => household.replaceAdditionalScope(c, b) },
  { method: 'DELETE', pattern: '/family/additional-responsible', handler: (c, _p, b) => household.revokeAdditionalResponsible(c, b) },
  { method: 'POST', pattern: '/family/transfer-primary-responsibility', handler: (c, _p, b) => household.transferPrimaryResponsibility(c, b) },

  { method: 'GET', pattern: '/friends', handler: (c) => friends.getFriends(c) },
  { method: 'GET', pattern: '/friends/code', handler: (c) => friends.getFriendCode(c) },
  { method: 'POST', pattern: '/friends/code/rotate', handler: (c) => friends.rotateFriendCode(c) },
  { method: 'POST', pattern: '/friends/requests', handler: (c, _p, b) => friends.createFriendRequest(c, b as never), status: 201 },
  { method: 'POST', pattern: '/friends/requests/:id/accept', handler: (c, p) => friends.acceptFriendRequest(c, p['id']) },
  { method: 'POST', pattern: '/friends/requests/:id/decline', handler: (c, p) => friends.declineFriendRequest(c, p['id']), status: 204 },
  { method: 'DELETE', pattern: '/friends/requests/:id', handler: (c, p) => friends.cancelFriendRequest(c, p['id']), status: 204 },
  { method: 'DELETE', pattern: '/friends/:friendshipId', handler: (c, p) => friends.removeFriend(c, p['friendshipId']), status: 204 },

  { method: 'POST', pattern: '/social/adult-friend-requests', handler: (c, _p, b) => social.createAdultFriendRequest(c, b as never), status: 201 },
  { method: 'POST', pattern: '/social/adult-friend-requests/:id/accept', handler: (c, p) => social.acceptAdultFriendRequest(c, p['id']) },
  { method: 'DELETE', pattern: '/social/friendships/:friendshipId', handler: (c, p) => social.removeSocialFriendship(c, p['friendshipId']), status: 204 },
  { method: 'POST', pattern: '/social/minor-invite-codes', handler: (c, _p, b) => social.mintMinorInviteCode(c, b as never), status: 201 },
  { method: 'POST', pattern: '/social/minor-friend-requests', handler: (c, _p, b) => social.createMinorFriendRequest(c, b as never), status: 201 },
  { method: 'GET', pattern: '/social/minor-friend-requests/:minorId', handler: (c, p) => social.getMinorFriendRequests(c, p['minorId']) },
  { method: 'POST', pattern: '/social/minor-friend-requests/:id/minor-accept', handler: (c, p, b) => social.recordMinorAcceptance(c, p['id'], b as never) },
  { method: 'POST', pattern: '/social/minor-friend-requests/:id/responsible-approve', handler: (c, p, b) => social.recordResponsibleApproval(c, p['id'], b as never) },
  { method: 'POST', pattern: '/social/minor-friend-requests/:id/reject', handler: (c, p, b) => social.rejectMinorFriendRequest(c, p['id'], b as never), status: 204 },
  { method: 'DELETE', pattern: '/social/minor-friendships/:friendshipId', handler: (c, p) => social.revokeMinorFriendship(c, p['friendshipId']), status: 204 },

  { method: 'GET', pattern: '/users/:id/forest', handler: (c, p) => forests.getForest(c, p['id']) },
  { method: 'GET', pattern: '/sync/changes', handler: (c, p) => sync.getSyncChanges(c, p['cursor']) },
  { method: 'POST', pattern: '/sync/push', handler: (c, _p, b) => sync.pushSync(c, b as never) },
  { method: 'POST', pattern: '/users/:id/sync/push', handler: (c, p, b) => sync.pushSyncFor(c, p['id'], b as never) },
];

export function matchRoute(
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  const segments = path.split('/').filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const patternSegments = route.pattern.split('/').filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segments[i]);
      else if (p !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

let deps: Deps | null = null;

type RouterEvent = APIGatewayProxyEventV2 | APIGatewayProxyEventV2WithJWTAuthorizer;

export function authTimeMillisFromClaims(
  claims: Record<string, unknown>,
): number | undefined {
  const raw = claims['auth_time'];
  const seconds = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Number.MAX_SAFE_INTEGER / 1_000) {
    return undefined;
  }
  return seconds * 1_000;
}

export async function handleEvent(
  event: RouterEvent,
  injected?: Deps,
): Promise<HttpResponse> {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    if (method === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };

    const d = injected ?? (deps ??= realDeps());
    const claims = 'authorizer' in event.requestContext
      ? event.requestContext.authorizer.jwt.claims
      : undefined;
    const sub = claims?.['sub'];
    if (typeof sub !== 'string' || !sub) throw new ApiError('UNAUTHENTICATED');

    const rawPath = event.rawPath.replace(/^\/v1(?=\/|$)/, '') || '/';
    const found = matchRoute(method, rawPath);
    if (!found) throw new ApiError('NOT_FOUND');

    const ctx = await resolveCaller(
      d,
      sub,
      authTimeMillisFromClaims((claims ?? {}) as Record<string, unknown>),
    );
    await requireFamilyRollout(ctx, method, found.route.pattern);
    // PATH params spread LAST (0.0.115 S1): a crafted `?userId=` used to
    // shadow the path's own `{userId}` before the handler ever saw it.
    const params = { ...(event.queryStringParameters ?? {}), ...found.params } as Record<string, string>;
    const result = await found.route.handler(ctx, params, parseJsonBody(event.body));
    return ok(result, found.route.status ?? 200);
  } catch (error) {
    return errorResponse(error);
  }
}

export const handler = instrumentHandler(
  'router',
  (event: RouterEvent, _context?: Context) => handleEvent(event),
);
