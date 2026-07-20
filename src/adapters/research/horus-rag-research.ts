import type { ModelProvider } from "../horus/port.js";
import type { ResearchRequest, ResearchSnippet } from "./port.js";
import type { ResearchSource } from "./source.js";
import { truncate } from "./util.js";

/**
 * Bridges the caller's OWN curated corpus into research via the ModelProvider's
 * optional `ragSearch` — the seam that shipped but no tool ever called. Free to
 * the operator (their infra) and the highest-trust source when present. Cleanly
 * no-ops (returns []) for providers without ragSearch (mock / plain gateway).
 */
export class HorusRagResearchSource implements ResearchSource {
  readonly name = "Curated corpus";

  constructor(private readonly provider: ModelProvider) {}

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    if (!this.provider.ragSearch) return [];
    try {
      const res = await this.provider.ragSearch({
        query: `${req.role ?? req.field} interview questions, required credentials, and proven preparation resources`,
        corpus: "interview-guides",
        topK: req.max ?? 6,
      });
      return (res.passages ?? [])
        .filter((p) => Boolean(p.url) && Boolean(p.text?.trim()))
        .map(
          (p): ResearchSnippet => ({
            kind: "resource",
            text: truncate(p.title ? `${p.title}: ${p.text}` : p.text, 240),
            sourceUrl: p.url!,
            sourceLabel: "Curated corpus",
          }),
        );
    } catch {
      return [];
    }
  }
}
