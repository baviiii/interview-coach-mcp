import type { ResearchRequest, ResearchSnippet } from "./port.js";
import type { ResearchSource } from "./source.js";
import { httpJson, stripHtml, truncate } from "./util.js";

/**
 * Keyless Wikipedia (Action API). The reliable, field-agnostic backbone for
 * non-tech credentials: where Reddit is anecdotal, Wikipedia names the actual
 * licensing bodies and primary credential for a role. Searches are scoped to the
 * learner's market first. Used for `fact` (role overview) and `credential`
 * (licensing pages). One or two search calls per bucket.
 */

interface WikiSearch {
  query?: { search?: Array<{ title: string; snippet?: string }> };
}

async function wikiSearch(query: string, limit: number): Promise<Array<{ title: string; snippet: string }>> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srprop=snippet&format=json&origin=*`;
  const json = await httpJson<WikiSearch>(url);
  return (json?.query?.search ?? []).map((s) => ({ title: s.title, snippet: stripHtml(s.snippet ?? "") }));
}

function pageUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/**
 * Full-text search matches on any word, so "Chef licence registration" returns
 * "Vehicle registration plates of Germany". Keep only pages whose title shares a
 * word stem with the field ("nurse" ~ "Nursing in Australia"); anything else is
 * noise that would reach the prompt as a "real-world signal" or a credential.
 */
export function titleFitsField(title: string, field: string): boolean {
  const stems = field
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, Math.max(4, w.length - 1)));
  const words = title.toLowerCase().split(/[^a-z]+/);
  return stems.some((s) => words.some((w) => w.startsWith(s)));
}

/** The market's own pages first ("Nursing in Australia"); the global ones only
 *  if the market has nothing relevant, so a thin local result never means none. */
async function scopedSearch(query: string, field: string, market: string | undefined, limit: number) {
  const relevant = (hits: Array<{ title: string; snippet: string }>) => hits.filter((h) => titleFitsField(h.title, field));
  if (market) {
    const local = relevant(await wikiSearch(`${query} ${market}`, limit + 2));
    if (local.length > 0) return local.slice(0, limit);
  }
  return relevant(await wikiSearch(query, limit + 2)).slice(0, limit);
}

export class WikipediaResearchSource implements ResearchSource {
  readonly name = "Wikipedia";

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    const intents = req.intents ?? ["fact", "credential"];
    const out: ResearchSnippet[] = [];
    const tasks: Array<Promise<void>> = [];

    if (intents.includes("fact")) {
      tasks.push(
        (async () => {
          const topic = req.role ?? req.field;
          const [hit] = await scopedSearch(topic, topic, req.market, 1);
          if (hit?.snippet) {
            out.push({
              kind: "fact",
              text: truncate(`${hit.title}: ${hit.snippet}`, 260),
              sourceUrl: pageUrl(hit.title),
              sourceLabel: "Wikipedia",
            });
          }
        })(),
      );
    }

    if (intents.includes("credential")) {
      tasks.push(
        (async () => {
          const hits = await scopedSearch(`${req.field} licence certification`, req.field, req.market, 3);
          for (const h of hits) {
            if (!h.snippet) continue;
            out.push({
              kind: "credential",
              text: truncate(`${h.title}: ${h.snippet}`, 240),
              sourceUrl: pageUrl(h.title),
              sourceLabel: "Wikipedia",
            });
          }
        })(),
      );
    }

    await Promise.all(tasks);
    return out;
  }
}
