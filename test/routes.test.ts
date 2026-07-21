import { describe, expect, it } from 'vitest';
import { API_PATHS } from '@app/api/contracts';
import { ROUTES, matchRoute } from '../lambda/router';

/**
 * Contract parity: every path the client transport can emit (http-api.ts,
 * via API_PATHS) must land on exactly one route with the same method.
 */
const CLIENT_CALLS: { method: string; path: string }[] = [
  { method: 'GET', path: API_PATHS.me },
  { method: 'PATCH', path: API_PATHS.me },
  { method: 'POST', path: API_PATHS.familyChildren },
  { method: 'POST', path: API_PATHS.familyChildResetPassword('u1') },
  { method: 'PATCH', path: API_PATHS.familyChild('u1') },
  { method: 'GET', path: API_PATHS.familyChildExport('u1') },
  { method: 'DELETE', path: API_PATHS.familyChild('u1') },
  { method: 'DELETE', path: API_PATHS.familyLink('g~m') },
  { method: 'POST', path: API_PATHS.familyInvites },
  { method: 'POST', path: API_PATHS.familyInvitesAccept },
  { method: 'DELETE', path: API_PATHS.familyInvite('C0DEC0DE') },
  { method: 'GET', path: API_PATHS.familyChildFriends('u1') },
  { method: 'DELETE', path: API_PATHS.familyChildFriend('u1', 'f1') },
  { method: 'DELETE', path: API_PATHS.familyChildRequest('u1', 'r1') },
  { method: 'GET', path: API_PATHS.friends },
  { method: 'GET', path: API_PATHS.friendCode },
  { method: 'POST', path: API_PATHS.friendCodeRotate },
  { method: 'POST', path: API_PATHS.friendRequests },
  { method: 'POST', path: API_PATHS.friendRequestAccept('r1') },
  { method: 'POST', path: API_PATHS.friendRequestDecline('r1') },
  { method: 'DELETE', path: API_PATHS.friendRequest('r1') },
  { method: 'DELETE', path: API_PATHS.friend('a~b') },
  { method: 'GET', path: API_PATHS.userForest('u1') },
  { method: 'GET', path: API_PATHS.syncChanges },
  { method: 'POST', path: API_PATHS.syncPush },
  { method: 'POST', path: API_PATHS.userSyncPush('u1') },
];

describe('router ↔ API_PATHS parity', () => {
  it('covers every client call', () => {
    for (const call of CLIENT_CALLS) {
      const found = matchRoute(call.method, call.path);
      expect(found, `${call.method} ${call.path}`).not.toBeNull();
    }
  });

  it('has no orphan routes the client never calls', () => {
    expect(ROUTES.length).toBe(CLIENT_CALLS.length);
  });

  it('extracts params and rejects unknown paths', () => {
    const hit = matchRoute('POST', '/family/children/abc-123/reset-password');
    expect(hit?.params['id']).toBe('abc-123');
    expect(matchRoute('GET', '/nope')).toBeNull();
    expect(matchRoute('DELETE', '/me')).toBeNull(); // right path, wrong method
  });
});
