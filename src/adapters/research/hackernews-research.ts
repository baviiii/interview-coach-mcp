import type { ResearchRequest, ResearchSnippet } from "./port.js";
import type { ResearchSource } from "./source.js";
import { httpJson, truncate } from "./util.js";

/**
 * Keyless Hacker News (Algolia). Tech-leaning, so it mostly contributes to
 * software/data fields; for non-tech fields it simply returns little and the
 * composite leans on Reddit + Wikipedia. Surfaces proven guides (real URLs) and
 * interview discussion threads.
 */

interface HnHit {
  title: string;
  url?: string;
  points?: number;
  num_comments?: number;
  objectID: string;
}

interface HnResponse {
  hits?: HnHit[];
}

async function hnSearch(query: string, n: number): Promise<HnHit[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${n}`;
  const json = await httpJson<HnResponse>(url);
  return (json?.hits ?? []).filter((h) => Boolean(h?.title)).sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
}

export class HackerNewsResearchSource implements ResearchSource {
  readonly name = "Hacker News";

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    const intents = req.intents ?? ["question", "resource"];
    if (!intents.includes("resource") && !intents.includes("question")) return [];
    const max = Math.max(2, Math.min(req.max ?? 4, 6));

    const hits = (await hnSearch(`${req.role ?? req.field} interview`, max + 4))
      .filter((h) => (h.points ?? 0) >= 20)
      .slice(0, max);

    const preferResource = intents.includes("resource");
    return hits.map((h) => {
      const itemUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
      return {
        kind: preferResource && h.url ? "resource" : "question",
        text: truncate(h.title, 140),
        sourceUrl: h.url ?? itemUrl,
        sourceLabel: "Hacker News",
        stat: `${h.points ?? 0} pts · ${h.num_comments ?? 0} comments`,
      } satisfies ResearchSnippet;
    });
  }
}
