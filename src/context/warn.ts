/**
 * Best-effort writes stay best-effort, but never silent: one warning per miss,
 * so a failure shows up in the server's logs instead of vanishing. Silently
 * swallowed errors are how a dropped column broke skill saving for months
 * without anyone noticing.
 */
export function warnDb(op: string, detail: unknown): void {
  const msg = (detail as { message?: string })?.message ?? String(detail);
  console.warn(`[db] ${op} failed (change not saved): ${msg}`);
}
