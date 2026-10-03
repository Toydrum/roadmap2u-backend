import { describe, expect, it } from 'vitest';
import { tempPassword } from '../lambda/codes';

describe('temporary credential generation', () => {
  it('generates a high-entropy password that satisfies the Cognito policy', () => {
    const oldWordPattern = /^(Brote|Rama|Hoja|Nube|Bosque|Semilla|Trebol|Musgo)(brote|rama|hoja|nube|bosque|semilla|trebol|musgo)\d{2}$/;

    for (let sample = 0; sample < 32; sample += 1) {
      const password = tempPassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).not.toMatch(oldWordPattern);
    }
  });
});
