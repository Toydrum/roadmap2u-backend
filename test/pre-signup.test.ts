import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handleEvent } from '../lambda/pre-signup';

function eventOf(
  userName: string,
  email?: string,
  triggerSource: PreSignUpTriggerEvent['triggerSource'] = 'PreSignUp_SignUp',
): PreSignUpTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_pool',
    userName,
    callerContext: {
      awsSdkVersion: '3',
      clientId: 'client-id',
    },
    triggerSource,
    request: {
      userAttributes: {
        sub: 'user-sub',
        ...(email === undefined ? {} : { email }),
      },
      validationData: undefined,
      clientMetadata: undefined,
    },
    response: {
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  };
}

describe('Cognito PreSignUp contract', () => {
  it.each(['abc', 'a_9', 'abcdefghijklmnopqrst'])(
    'accepts the canonical username %s without rewriting it',
    (username) => {
      const event = eventOf(username, 'adult+signup@example.com');

      expect(handleEvent(event)).toBe(event);
      expect(event.userName).toBe(username);
    },
  );

  it.each([
    'ab',
    'abcdefghijklmnopqrstu',
    'Rocio',
    'rocio-',
    'rocio adulto',
    ' rocio',
    'rocio ',
    'rocío',
  ])('rejects the non-canonical username %j instead of normalizing it', (username) => {
    expect(() => handleEvent(eventOf(username, 'adult@example.com'))).toThrow(
      'username must match ^[a-z0-9_]{3,20}$',
    );
  });

  it.each([undefined, '', ' ', 'adult', 'adult@', '@example.com', 'adult @example.com'])(
    'rejects a self-signup with invalid email %j',
    (email) => {
      expect(() => handleEvent(eventOf('adult_user', email))).toThrow(
        'self-signup requires a valid email',
      );
    },
  );

  it('allows a guardian-created minor to omit email while keeping a canonical username', () => {
    const event = eventOf('minor_user', undefined, 'PreSignUp_AdminCreateUser');

    expect(handleEvent(event)).toBe(event);
  });

  it('still rejects a non-canonical guardian-created username', () => {
    expect(() =>
      handleEvent(eventOf('Minor_User', undefined, 'PreSignUp_AdminCreateUser')),
    ).toThrow('username must match ^[a-z0-9_]{3,20}$');
  });
});
