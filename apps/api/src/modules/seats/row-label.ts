/** Row labels like a theatre: A..Z, AA..AZ, BA.. (zero-based index). */
export function rowLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
