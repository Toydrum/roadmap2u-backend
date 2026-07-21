import { randomInt } from 'node:crypto';

/**
 * Server-side code/password generation — crypto RNG (determinism is a MOCK
 * property; see backend-contract.md §8).
 */

/** Crockford-ish base32 minus vowels and lookalikes (0/O, 1/I/L, 5/S, 8/B kept out). */
const CODE_ALPHABET = '2346790CDFGHJKMNPQRTVWXZ';

export function friendCode(length = 8): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Meets PASSWORD_POLICY (upper + lower + digit, ≥8) with gentle words. */
export function tempPassword(): string {
  const words = ['Brote', 'Rama', 'Hoja', 'Nube', 'Bosque', 'Semilla', 'Trebol', 'Musgo'];
  return `${words[randomInt(words.length)]}${words[randomInt(words.length)].toLowerCase()}${randomInt(10, 100)}`;
}
