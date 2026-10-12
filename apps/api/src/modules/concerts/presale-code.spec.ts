import {
  formatPresaleCode,
  newPresaleCode,
  normalizePresaleCode,
  PRESALE_CODE_LENGTH,
} from './presale-code.js';

describe('presale codes', () => {
  it('are 10 symbols without look-alikes (0/O, 1/I/L, U)', () => {
    for (let i = 0; i < 1000; i++) {
      const code = newPresaleCode();
      expect(code).toHaveLength(PRESALE_CODE_LENGTH);
      expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]+$/);
    }
  });

  it('are random enough not to repeat in 100,000 draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i++) seen.add(newPresaleCode());
    expect(seen.size).toBe(100_000);
  });

  it('typed in any case, with spaces or dashes, normalize to the stored form', () => {
    const code = newPresaleCode();
    const shown = formatPresaleCode(code);
    expect(shown).toMatch(/^.{4}-.{4}-.{2}$/);
    expect(normalizePresaleCode(shown)).toBe(code);
    expect(
      normalizePresaleCode(` ${shown.toLowerCase().replace(/-/g, ' ')} `),
    ).toBe(code);
  });
});
