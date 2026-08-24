// Strict ISO-8601 validation shared by manual (no class-validator) request
// validation. Bare Date.parse is too permissive ('July 3 2026', '2026/07/03'
// pass), which lets non-ISO strings reach $::timestamptz casts and 500. Match a
// date or date-time (optional time / seconds / fraction / timezone) AND require
// Date.parse to accept it (catches impossible dates like 2026-13-40).
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

export function isIso8601(v: string): boolean {
  return ISO_8601_RE.test(v) && !Number.isNaN(Date.parse(v));
}
