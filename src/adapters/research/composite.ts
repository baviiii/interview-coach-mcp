import { emptyResearch, type FieldResearch, type ResearchPort, type ResearchRequest } from "./port.js";
import type { ResearchSource } from "./source.js";
import { bucketSnippets } from "./util.js";

/**
 * Fans out across the configured free sources in parallel, merges + dedupes +
 * caps the results, and caches them. Research changes slowly, so a generous TTL
 * keeps us well inside free-API rate limits across a user's session. Best-effort
 * throughout: a failing source is swallowed and flagged `partial`, never thrown.
 */
const TTL_MS = 30 * 60 * 1000;
const MAX_PER_KIND = 6;

export class CompositeResearch implements ResearchPort {
  private cache = new Map<string, { at: number; val: FieldResearch }>();

  constructor(private readonly sources: ResearchSource[]) {}

  async researchField(req: ResearchRequest): Promise<FieldResearch> {
    if (!req.field?.trim()) return emptyResearch(req.field ?? "", req.role);

    const key = cacheKey(req);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.val;

    const settled = await Promise.allSettled(this.sources.map((s) => s.gather(req)));
    const snippets = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const partial = settled.some((r) => r.status === "rejected");

    const val = bucketSnippets(req.field, req.role, snippets, req.max ?? MAX_PER_KIND, partial);
    this.cache.set(key, { at: Date.now(), val });
    return val;
  }
}

function cacheKey(req: ResearchRequest): string {
  const intents = (req.intents ?? []).slice().sort().join(",");
  return [req.field, req.role ?? "", req.seniority ?? "", req.market ?? "", intents, req.max ?? ""]
    .map((p) => String(p).toLowerCase())
    .join("|");
}
