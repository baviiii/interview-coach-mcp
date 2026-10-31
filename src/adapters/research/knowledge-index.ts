/**
 * The knowledge index: Horus's corpus of Australian career documents —
 * Jobs and Skills Australia reports, government and recruiter interview
 * guides, selection-criteria guides, state career and skills material. It
 * reaches us through CareerCraft's `horus-rag` function, op "careers-search":
 * retrieval only (no model writes an answer), restricted by Horus to the
 * careers categories, so budget papers never come back.
 *
 * How a search is made, and why it's careful:
 *
 *   - It runs as the learner. horus-rag only answers a signed-in user, so the
 *     request carries their Supabase token (ResearchRequest.userToken).
 *   - It spends the learner's allowance. Every search counts against their
 *     plan's "Career intelligence search" (Free: 20 a month, 10 an hour), the
 *     same allowance the Intelligence page uses. So it only runs when a tool
 *     asks for it (ResearchRequest.knowledgeIndex): tips, resources and the
 *     learning pathway, not every interview question.
 *   - One search per job, shared. The query depends only on the job, so the
 *     tips and the resources for "Registered Nurse" are one search, and the
 *     results are kept for six hours for every learner (the corpus isn't
 *     personal). A failed search isn't kept, so the next request tries again.
 *   - Nothing ever breaks a tool. No token, a spent allowance (429), a busy
 *     function (BOOT_ERROR, retried like model calls), a timeout: all of them
 *     are "nothing found".
 *
 * This replaces HorusRagResearchSource, which called the retired
 * `rag-metadata` function with this server's key; that function wants a user
 * token, so every search failed with 401 and research quietly got nothing.
 */

import { retryDelay } from "../horus/http-client.js";
import type { ResearchKind, ResearchRequest, ResearchSnippet } from "./port.js";
import type { ResearchSource } from "./source.js";
import { truncate } from "./util.js";

/** Results kept per search, for every learner. */
const CACHE_MS = 6 * 60 * 60 * 1000;
/** A search that hasn't answered by now is skipped: research must stay quick. */
const TIMEOUT_MS = 8000;
/** How many documents to ask for. Each still costs one search, whatever the number. */
const TOP_K = 8;
/**
 * horus-rag reports relevance as 1–99 (Horus's hybrid score, rescaled). The
 * search already keeps to careers documents and returns the best few, so this
 * only drops the faint tail.
 */
export const MIN_RELEVANCE = 20;

/** A source as horus-rag returns it for op "careers-search". */
export interface KnowledgeSource {
  title?: string;
  content?: string;
  url?: string;
  /** 1–99. */
  score?: number;
}

/**
 * What to search for. It names the job and the things the coach uses the
 * index for, and nothing about the learner, so every learner going for the
 * same job shares one search.
 */
export function knowledgeQuery(req: Pick<ResearchRequest, "field" | "role">): string {
  const job = (req.role ?? req.field).trim();
  return `${job}: job interview preparation, selection criteria, qualifications and training`;
}

/**
 * The research bucket the documents go into, from what the tool asked for.
 * The same documents serve as resources for the Resources tab and as the
 * real-world signals tips are written from.
 */
export function knowledgeKind(intents: ResearchKind[] | undefined): ResearchKind {
  const wanted = intents?.length ? intents : (["resource"] as ResearchKind[]);
  if (wanted.includes("resource")) return "resource";
  if (wanted.includes("experience")) return "experience";
  if (wanted.includes("question")) return "question";
  if (wanted.includes("credential")) return "credential";
  return "fact";
}

/** horus-rag's sources as research snippets: one per document, faint matches dropped. */
export function toSnippets(sources: KnowledgeSource[], kind: ResearchKind): ResearchSnippet[] {
  const seen = new Set<string>();
  const out: ResearchSnippet[] = [];
  for (const s of sources) {
    const url = s.url?.trim();
    const text = s.content?.trim();
    if (!url || !text || (s.score ?? 0) < MIN_RELEVANCE) continue;
    // Several passages can come from one document; the best-ranked one stands for it.
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      kind,
      text: truncate(text, 240),
      sourceUrl: url,
      sourceLabel: truncate(s.title?.trim() || "Career knowledge base", 80),
      stat: "Knowledge base",
      origin: "knowledge-index",
    });
  }
  return out;
}

export class KnowledgeIndexResearchSource implements ResearchSource {
  readonly name = "Knowledge base";
  private cache = new Map<string, { at: number; sources: KnowledgeSource[] }>();

  constructor(private readonly opts: { url: string | null | undefined; anonKey?: string | null }) {}

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    if (!req.knowledgeIndex || !req.userToken || !this.opts.url || !req.field?.trim()) return [];
    const query = knowledgeQuery(req);
    const key = query.toLowerCase();
    const cached = this.cache.get(key);
    let sources = cached && Date.now() - cached.at < CACHE_MS ? cached.sources : null;
    if (!sources) {
      sources = await this.search(query, req.userToken);
      if (sources) this.cache.set(key, { at: Date.now(), sources });
    }
    return toSnippets(sources ?? [], knowledgeKind(req.intents));
  }

  /** One careers-search as the learner. Null when it didn't work, so it isn't cached. */
  private async search(query: string, userToken: string): Promise<KnowledgeSource[] | null> {
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(this.opts.url!, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
            ...(this.opts.anonKey ? { apikey: this.opts.anonKey } : {}),
          },
          body: JSON.stringify({ op: "careers-search", query, options: { topK: TOP_K } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return null;
      }
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { sources?: KnowledgeSource[]; error?: unknown } | null;
        // horus-rag answers 200 with an `error` for a fault it handled upstream:
        // that's a failure (not remembered), unlike `notFound`, a real "nothing".
        if (!body || body.error) return null;
        return Array.isArray(body.sources) ? body.sources : [];
      }
      const text = await res.text().catch(() => "");
      const wait = retryDelay(res.status, text, attempt);
      if (wait === null) {
        // 429 is the learner's allowance running out: expected, and not worth a warning.
        if (res.status !== 429) console.warn(`[research] knowledge index ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
