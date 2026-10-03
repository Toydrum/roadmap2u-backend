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

const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const PASSWORD_DIGITS = '234679';
const PASSWORD_ALPHABET = `${PASSWORD_UPPER}${PASSWORD_LOWER}${PASSWORD_DIGITS}`;

function randomCharacter(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!;
}

/**
 * Meets PASSWORD_POLICY while keeping at least 128 bits of effective entropy.
 * Required classes are chosen independently and the remaining positions draw
 * from the full alphabet before a crypto-random Fisher-Yates shuffle.
 */
export function tempPassword(): string {
  const characters = [
    randomCharacter(PASSWORD_UPPER),
    randomCharacter(PASSWORD_LOWER),
    randomCharacter(PASSWORD_DIGITS),
    ...Array.from({ length: 21 }, () => randomCharacter(PASSWORD_ALPHABET)),
  ];
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(index + 1);
    [characters[index], characters[swapWith]] = [characters[swapWith]!, characters[index]!];
  }
  return characters.join('');
}
