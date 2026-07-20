/** Small, dependency-free helpers shared by the research sources. */

import { emptyResearch, type FieldResearch, type ResearchKind, type ResearchSnippet } from "./port.js";

const DEFAULT_TIMEOUT_MS = 6000;

/** GET JSON with a hard timeout. Returns null on any failure (never throws) so
 *  every source degrades to "no evidence" rather than breaking the tool. */
export async function httpJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Collapse whitespace and cap length with an ellipsis. */
export function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

/** Strip HTML tags + common entities (Wikipedia search snippets are HTML). */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/gi, " ");
}

/** 1234 → "1.2k". */
export function fmtCount(n?: number): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}

/** Fold a flat, kind-tagged snippet list into a FieldResearch bundle:
 *  drops sourceless/empty snippets, dedupes by URL across all buckets, and caps
 *  each bucket. The single place bucketing + hygiene live. */
export function bucketSnippets(
  field: string,
  role: string | undefined,
  snippets: ResearchSnippet[],
  maxPerKind: number,
  partial: boolean,
): FieldResearch {
  const out = emptyResearch(field, role, partial);
  const seenUrls = new Set<string>();
  for (const s of snippets) {
    if (!s?.sourceUrl || !s.text?.trim()) continue;
    if (seenUrls.has(s.sourceUrl)) continue;
    seenUrls.add(s.sourceUrl);
    const bucket = bucketFor(out, s.kind);
    if (bucket.length < maxPerKind) bucket.push(s);
  }
  return out;
}

function bucketFor(r: FieldResearch, kind: ResearchKind): ResearchSnippet[] {
  switch (kind) {
    case "question":
      return r.questions;
    case "experience":
      return r.experiences;
    case "credential":
      return r.credentials;
    case "resource":
      return r.resources;
    case "fact":
      return r.facts;
  }
}
