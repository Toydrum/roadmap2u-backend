import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { USERNAME_PATTERN } from '@app/auth/auth-types';

const EMAIL_LOCAL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;

function selfSignupEmailIsValid(value: string | undefined): boolean {
  if (!value || value.length > 254 || value !== value.trim() || /\s/.test(value)) return false;

  const separator = value.indexOf('@');
  if (separator <= 0 || separator !== value.lastIndexOf('@')) return false;

  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !EMAIL_LOCAL_PATTERN.test(local)
  ) {
    return false;
  }

  const labels = domain.split('.');
  return labels.length >= 2 && labels.every((label) => EMAIL_DOMAIN_LABEL_PATTERN.test(label));
}

/** Enforce the shared identity contract before Cognito persists any username. */
export function handleEvent(event: PreSignUpTriggerEvent): PreSignUpTriggerEvent {
  if (!USERNAME_PATTERN.test(event.userName)) {
    throw new Error('username must match ^[a-z0-9_]{3,20}$');
  }

  // Guardian-created minors intentionally have no email. Direct self-signup
  // always creates an adult and therefore requires a recovery address.
  if (
    event.triggerSource === 'PreSignUp_SignUp' &&
    !selfSignupEmailIsValid(event.request.userAttributes.email)
  ) {
    throw new Error('self-signup requires a valid email');
  }

  return event;
}

export const handler = async (event: PreSignUpTriggerEvent) => handleEvent(event);
