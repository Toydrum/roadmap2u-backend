import { describe, expect, it } from 'vitest';

type SocialModelModule = {
  canonicalFriendshipPair(leftAccountId: string, rightAccountId: string): {
    friendshipId: string;
    userA: string;
    userB: string;
  };
  friendshipSide(friendshipId: string, accountId: string): 'A' | 'B';
  createPendingMinorFriendship(input: {
    requesterId: string;
    recipientId: string;
    requestCycleId: string;
    now: number;
    expiresAt: number;
  }): unknown;
  createActiveAdultFriendship(input: {
    leftAccountId: string;
    rightAccountId: string;
    now: number;
  }): unknown;
  createMinorFriendInviteCode(input: {
    code: string;
    minorId: string;
    issuedById: string;
    now: number;
    expiresAt: number;
  }): unknown;
  createMinorFriendConsent(input: {
    friendship: unknown;
    kind:
      | 'requester_action'
      | 'requester_responsible_approval'
      | 'recipient_acceptance'
      | 'recipient_responsible_approval';
    actorId: string;
    subjectMinorId: string;
    policyVersion: string;
    now: number;
  }): Record<string, unknown>;
  hasFourCurrentMinorFriendConsents(
    friendship: unknown,
    consents: readonly unknown[],
    now: number,
  ): boolean;
  activateMinorFriendship(
    friendship: unknown,
    consents: readonly unknown[],
    now: number,
  ): Record<string, unknown>;
  SK: {
    friendship(leftAccountId: string, rightAccountId: string): { pk: string; sk: string };
    consent(
      leftAccountId: string,
      rightAccountId: string,
      subjectAccountId: string,
      kind: string,
    ): { pk: string; sk: string };
    minorInviteCode(code: string): { pk: string; sk: string };
  };
};

async function loadModel(): Promise<SocialModelModule | null> {
  const modulePath = '../lambda/social/' + 'model';
  return import(modulePath).catch(() => null) as Promise<SocialModelModule | null>;
}

describe('social model v2', () => {
  it('canonicalizes account pairs and materializes the exact single-table keys', async () => {
    const model = await loadModel();
    expect(model?.canonicalFriendshipPair).toBeTypeOf('function');

    const pair = model!.canonicalFriendshipPair('minor-z', 'minor-a');
    expect(pair).toEqual({
      friendshipId: 'minor-a~minor-z',
      userA: 'minor-a',
      userB: 'minor-z',
    });
    expect(model!.canonicalFriendshipPair('minor-a', 'minor-z')).toEqual(pair);
    expect(model!.friendshipSide(pair.friendshipId, 'minor-a')).toBe('A');
    expect(model!.friendshipSide(pair.friendshipId, 'minor-z')).toBe('B');
    expect(model!.SK.friendship('minor-z', 'minor-a')).toEqual({
      pk: 'FRIENDSHIP#minor-a~minor-z',
      sk: 'META',
    });
    expect(
      model!.SK.consent('minor-z', 'minor-a', 'minor-z', 'requester_action'),
    ).toEqual({
      pk: 'FRIENDSHIP#minor-a~minor-z',
      sk: 'CONSENT#B#requester_action',
    });
    expect(model!.SK.minorInviteCode('CDFGHJKM')).toEqual({
      pk: 'CODE#MF#CDFGHJKM',
      sk: 'CODE',
    });
  });

  it('creates a pending minor friendship bound to one request cycle', async () => {
    const model = await loadModel();
    expect(model?.createPendingMinorFriendship).toBeTypeOf('function');

    expect(
      model!.createPendingMinorFriendship({
        requesterId: 'minor-z',
        recipientId: 'minor-a',
        requestCycleId: 'cycle-1',
        now: 1_800_000_000_000,
        expiresAt: 1_801_209_600_000,
      }),
    ).toEqual({
      pk: 'FRIENDSHIP#minor-a~minor-z',
      sk: 'META',
      entityType: 'Friendship',
      friendshipId: 'minor-a~minor-z',
      userA: 'minor-a',
      userB: 'minor-z',
      friendshipClass: 'minor_minor',
      state: 'pending',
      requestId: 'minor-friend:minor-a~minor-z',
      requestCycleId: 'cycle-1',
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      revision: 1,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
      activatedAt: null,
      endedAt: null,
    });
  });

  it('creates one active friendship for the exact direct pair', async () => {
    const model = await loadModel();
    expect(model?.createActiveAdultFriendship).toBeTypeOf('function');

    expect(
      model!.createActiveAdultFriendship({
        leftAccountId: 'adult-b',
        rightAccountId: 'adult-a',
        now: 1_800_000_000_000,
      }),
    ).toEqual({
      pk: 'FRIENDSHIP#adult-a~adult-b',
      sk: 'META',
      entityType: 'Friendship',
      friendshipId: 'adult-a~adult-b',
      userA: 'adult-a',
      userB: 'adult-b',
      friendshipClass: 'adult_adult',
      state: 'active',
      requestId: null,
      requestCycleId: null,
      requesterId: null,
      recipientId: null,
      revision: 1,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      expiresAt: null,
      activatedAt: 1_800_000_000_000,
      endedAt: null,
    });
  });

  it('creates a one-use minor code with a bounded 24-hour lifetime', async () => {
    const model = await loadModel();
    expect(model?.createMinorFriendInviteCode).toBeTypeOf('function');

    expect(
      model!.createMinorFriendInviteCode({
        code: 'CDFGHJKM',
        minorId: 'minor-a',
        issuedById: 'adult-primary',
        now: 1_800_000_000_000,
        expiresAt: 1_800_086_400_000,
      }),
    ).toEqual({
      pk: 'CODE#MF#CDFGHJKM',
      sk: 'CODE',
      entityType: 'MinorFriendInviteCode',
      kind: 'minor_friend',
      code: 'CDFGHJKM',
      minorId: 'minor-a',
      issuedById: 'adult-primary',
      createdAt: 1_800_000_000_000,
      expiresAt: 1_800_086_400_000,
      ttl: Math.floor(1_800_086_400_000 / 1000),
    });
  });

  it('binds a consent row to the exact request cycle and canonical account side', async () => {
    const model = await loadModel();
    expect(model?.createMinorFriendConsent).toBeTypeOf('function');
    const friendship = model!.createPendingMinorFriendship({
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      requestCycleId: 'cycle-1',
      now: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
    });

    expect(
      model!.createMinorFriendConsent({
        friendship,
        kind: 'requester_action',
        actorId: 'minor-z',
        subjectMinorId: 'minor-z',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_001,
      }),
    ).toEqual({
      pk: 'FRIENDSHIP#minor-a~minor-z',
      sk: 'CONSENT#B#requester_action',
      entityType: 'Consent',
      friendshipId: 'minor-a~minor-z',
      requestId: 'minor-friend:minor-a~minor-z',
      requestCycleId: 'cycle-1',
      side: 'B',
      kind: 'requester_action',
      actorId: 'minor-z',
      subjectMinorId: 'minor-z',
      policyVersion: 'minor-social-v1',
      revision: 1,
      recordedAt: 1_800_000_000_001,
    });
  });

  it('recognizes all four consent kinds only for the current request cycle', async () => {
    const model = await loadModel();
    expect(model?.hasFourCurrentMinorFriendConsents).toBeTypeOf('function');
    const friendship = model!.createPendingMinorFriendship({
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      requestCycleId: 'cycle-1',
      now: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
    });
    const consent = (
      kind:
        | 'requester_action'
        | 'requester_responsible_approval'
        | 'recipient_acceptance'
        | 'recipient_responsible_approval',
      actorId: string,
      subjectMinorId: string,
    ) =>
      model!.createMinorFriendConsent({
        friendship,
        kind,
        actorId,
        subjectMinorId,
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_001,
      });
    const consents = [
      consent('requester_action', 'minor-z', 'minor-z'),
      consent('requester_responsible_approval', 'adult-z', 'minor-z'),
      consent('recipient_acceptance', 'minor-a', 'minor-a'),
      consent('recipient_responsible_approval', 'adult-a', 'minor-a'),
    ];

    expect(
      model!.hasFourCurrentMinorFriendConsents(
        friendship,
        consents,
        1_800_000_000_002,
      ),
    ).toBe(true);
    expect(
      model!.hasFourCurrentMinorFriendConsents(
        friendship,
        [{ ...consents[0], requestCycleId: 'cycle-old' }, ...consents.slice(1)],
        1_800_000_000_002,
      ),
    ).toBe(false);
  });

  it('activates exactly one minor friendship only for the complete one of 16 consent subsets', async () => {
    const model = await loadModel();
    expect(model?.activateMinorFriendship).toBeTypeOf('function');
    const friendship = model!.createPendingMinorFriendship({
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      requestCycleId: 'cycle-1',
      now: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
    });
    const consents = [
      model!.createMinorFriendConsent({
        friendship,
        kind: 'requester_action',
        actorId: 'minor-z',
        subjectMinorId: 'minor-z',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_001,
      }),
      model!.createMinorFriendConsent({
        friendship,
        kind: 'requester_responsible_approval',
        actorId: 'adult-z',
        subjectMinorId: 'minor-z',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_002,
      }),
      model!.createMinorFriendConsent({
        friendship,
        kind: 'recipient_acceptance',
        actorId: 'minor-a',
        subjectMinorId: 'minor-a',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_003,
      }),
      model!.createMinorFriendConsent({
        friendship,
        kind: 'recipient_responsible_approval',
        actorId: 'adult-a',
        subjectMinorId: 'minor-a',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_004,
      }),
    ];

    for (let mask = 0; mask < 16; mask += 1) {
      const subset = consents.filter((_consent, index) => (mask & (1 << index)) !== 0);
      if (mask === 15) {
        expect(
          model!.activateMinorFriendship(friendship, subset, 1_800_000_000_005),
        ).toMatchObject({
          friendshipClass: 'minor_minor',
          state: 'active',
          revision: 2,
          activatedAt: 1_800_000_000_005,
          expiresAt: 1_801_209_600_000,
          endedAt: null,
        });
      } else {
        expect(() =>
          model!.activateMinorFriendship(friendship, subset, 1_800_000_000_005),
        ).toThrow(/four current consents/i);
      }
    }
  });

  it('fails closed when a persisted responsible approval has a malformed actor', async () => {
    const model = await loadModel();
    const friendship = model!.createPendingMinorFriendship({
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      requestCycleId: 'cycle-1',
      now: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
    });
    const consent = (
      kind:
        | 'requester_action'
        | 'requester_responsible_approval'
        | 'recipient_acceptance'
        | 'recipient_responsible_approval',
      actorId: string,
      subjectMinorId: string,
    ) =>
      model!.createMinorFriendConsent({
        friendship,
        kind,
        actorId,
        subjectMinorId,
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_001,
      });
    const consents = [
      consent('requester_action', 'minor-z', 'minor-z'),
      {
        ...consent('requester_responsible_approval', 'adult-z', 'minor-z'),
        actorId: '',
      },
      consent('recipient_acceptance', 'minor-a', 'minor-a'),
      consent('recipient_responsible_approval', 'adult-a', 'minor-a'),
    ];

    expect(
      model!.hasFourCurrentMinorFriendConsents(
        friendship,
        consents,
        1_800_000_000_002,
      ),
    ).toBe(false);
  });

  it('rejects a consent timestamp before the request existed', async () => {
    const model = await loadModel();
    const friendship = model!.createPendingMinorFriendship({
      requesterId: 'minor-z',
      recipientId: 'minor-a',
      requestCycleId: 'cycle-1',
      now: 1_800_000_000_000,
      expiresAt: 1_801_209_600_000,
    });

    expect(() =>
      model!.createMinorFriendConsent({
        friendship,
        kind: 'requester_action',
        actorId: 'minor-z',
        subjectMinorId: 'minor-z',
        policyVersion: 'minor-social-v1',
        now: 1_799_999_999_999,
      }),
    ).toThrow(/request window/i);
  });

  it('rejects consent creation from a friendship row with a forged request id', async () => {
    const model = await loadModel();
    const friendship = {
      ...(model!.createPendingMinorFriendship({
        requesterId: 'minor-z',
        recipientId: 'minor-a',
        requestCycleId: 'cycle-1',
        now: 1_800_000_000_000,
        expiresAt: 1_801_209_600_000,
      }) as Record<string, unknown>),
      requestId: 'minor-friend:minor-a~minor-x',
    };

    expect(() =>
      model!.createMinorFriendConsent({
        friendship,
        kind: 'requester_action',
        actorId: 'minor-z',
        subjectMinorId: 'minor-z',
        policyVersion: 'minor-social-v1',
        now: 1_800_000_000_001,
      }),
    ).toThrow(/canonical request/i);
  });
});
