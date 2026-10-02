import { rowLabel } from './row-label.js';

describe('rowLabel', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('row %i is %s', (index, label) => {
    expect(rowLabel(index)).toBe(label);
  });
});
