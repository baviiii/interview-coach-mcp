import type { ResearchRequest, ResearchSnippet } from "./port.js";
import type { ResearchSource } from "./source.js";
import { httpJson, stripHtml, truncate } from "./util.js";

/**
 * Keyless Wikipedia (Action API). The reliable, field-agnostic backbone for
 * non-tech credentials: where Reddit is anecdotal, Wikipedia names the actual
 * licensing exams and primary credential for a role (e.g. "Registered nurse" →
 * NCLEX, state licensure). Used for `fact` (role overview) and `credential`
 * (licensing/exam pages). One search call per bucket.
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

export class WikipediaResearchSource implements ResearchSource {
  readonly name = "Wikipedia";

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    const intents = req.intents ?? ["fact", "credential"];
    const out: ResearchSnippet[] = [];
    const tasks: Array<Promise<void>> = [];

    if (intents.includes("fact")) {
      tasks.push(
        (async () => {
          const [hit] = await wikiSearch(req.role ?? req.field, 1);
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
          const hits = await wikiSearch(`${req.field} license certification exam`, 3);
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
