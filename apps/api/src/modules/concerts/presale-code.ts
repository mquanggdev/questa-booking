import { randomInt } from 'node:crypto';

// Crockford-style alphabet without the look-alikes 0/O, 1/I/L and U:
// 30 symbols, 10 of them per code: 30^10, about 49 bits of randomness.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PRESALE_CODE_LENGTH = 10;

/** A random code from a CSPRNG, stored without dashes ("K7QM2XRP9D"). */
export function newPresaleCode(): string {
  let code = '';
  for (let i = 0; i < PRESALE_CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** What a person types ("k7qm-2xrp 9d") to the stored form ("K7QM2XRP9D"). */
export function normalizePresaleCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Stored form to the form shown to people: "K7QM-2XRP-9D". */
export function formatPresaleCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}
