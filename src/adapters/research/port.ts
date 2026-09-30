/**
 * ResearchPort — the "research BEFORE generate" seam. This is what makes the
 * coach career-agnostic and grounded instead of tech-hardcoded.
 *
 * GroundingPort proves a claim the model already wrote (a link AFTER the fact).
 * ResearchPort is the opposite direction: it gathers REAL, cited material about
 * a field *up front* — what people actually get asked, where they struggled,
 * which licenses/certs the field requires, what courses the community swears by
 * — and hands it to the prompt so the model anchors on reality for ANY field
 * (nurse, welder, paralegal, chef), not just software.
 *
 * Every snippet carries a real `sourceUrl`. Nothing sourceless is ever returned,
 * so a tool either grounds on something real or honestly has nothing to add.
 *
 * Free implementations (no API key): Reddit + Hacker News + Wikipedia, plus the
 * caller's own Horus RAG corpus when the ModelProvider exposes `ragSearch`. A
 * paid web-search provider (Tavily/Exa) or an HTTP "research bridge" can drop in
 * behind this same interface later without touching any tool code.
 */

export type ResearchKind =
  | "question" // a real interview question / theme reported for the field
  | "experience" // "users who had issues" — a real account of a struggle/mistake
  | "credential" // a license/cert/exam the field actually expects
  | "resource" // a course/book/guide the community recommends
  | "fact"; // an encyclopedic fact about the role/credential (Wikipedia)

/** One real, cited piece of evidence. A snippet without a `sourceUrl` is invalid
 *  and is dropped before it ever reaches a tool. */
export interface ResearchSnippet {
  kind: ResearchKind;
  /** The real quote, post title, or extracted summary. */
  text: string;
  /** Permalink to the source — REQUIRED. No URL ⇒ snippet is discarded. */
  sourceUrl: string;
  /** Human-readable source, e.g. "r/nursing", "Hacker News", "Wikipedia". */
  sourceLabel: string;
  /** Optional credibility signal, e.g. "1.2k upvotes", "340 pts". */
  stat?: string;
}

/** Everything we learned about a field in one bundle. Each list may be empty;
 *  `partial` is set when one or more sources failed (research is best-effort and
 *  never throws — tools degrade to their pre-research behavior). */
export interface FieldResearch {
  field: string;
  role?: string;
  questions: ResearchSnippet[];
  experiences: ResearchSnippet[];
  credentials: ResearchSnippet[];
  resources: ResearchSnippet[];
  facts: ResearchSnippet[];
  /** True if at least one source errored or timed out. */
  partial: boolean;
  /** Epoch ms when assembled (used for cache freshness + telemetry). */
  fetchedAt: number;
}

export interface ResearchRequest {
  field: string;
  role?: string;
  seniority?: string;
  jobDescription?: string;
  /** Job market (country) to scope locality-sensitive queries — licences,
   *  courses, role facts. Interview questions stay global for volume. */
  market?: string;
  /** Which buckets to fill. Omitted ⇒ all of them. Lets a tool fetch only what
   *  it needs (e.g. questions just want "question" + "experience"). */
  intents?: ResearchKind[];
  /** Soft cap on snippets per bucket. Defaults to a small number to respect
   *  free-API rate limits. */
  max?: number;
}

export interface ResearchPort {
  /** Gather real, cited material about a field. Never throws — returns an empty
   *  (but well-formed) FieldResearch with `partial: true` if everything failed. */
  researchField(req: ResearchRequest): Promise<FieldResearch>;
}

/** An empty, well-formed result. Use as the safe degrade value everywhere. */
export function emptyResearch(field: string, role?: string, partial = false): FieldResearch {
  return {
    field,
    role,
    questions: [],
    experiences: [],
    credentials: [],
    resources: [],
    facts: [],
    partial,
    fetchedAt: Date.now(),
  };
}

/** True when a bundle carries no usable evidence at all. Tools use this to skip
 *  the "REAL-WORLD SIGNALS" prompt block entirely rather than emit an empty one. */
export function researchIsEmpty(r: FieldResearch | undefined | null): boolean {
  if (!r) return true;
  return (
    r.questions.length === 0 &&
    r.experiences.length === 0 &&
    r.credentials.length === 0 &&
    r.resources.length === 0 &&
    r.facts.length === 0
  );
}

/** Flat count of all snippets — handy for `_meta`. */
export function researchCount(r: FieldResearch): number {
  return (
    r.questions.length + r.experiences.length + r.credentials.length + r.resources.length + r.facts.length
  );
}

/** Distinct source labels present, for `_meta.researchSources`. */
export function researchSources(r: FieldResearch): string[] {
  const all = [...r.questions, ...r.experiences, ...r.credentials, ...r.resources, ...r.facts];
  return [...new Set(all.map((s) => s.sourceLabel))];
}
