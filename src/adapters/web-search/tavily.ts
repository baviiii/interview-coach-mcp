/**
 * Tavily (api.tavily.com) — a search API built for AI apps. Site lists go
 * straight into the request (include_domains / exclude_domains), and the
 * learner's country boosts local results. 1,000 free searches a month, then
 * about US$0.008 each. The key travels in the Authorization header and is
 * never logged.
 */

import { cleanResults, siteOf, type WebResult, type WebSearchProvider, type WebSearchRequest } from "./port.js";

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 10_000;

/** Tavily's `country` takes the country's name in lower case, and only for general searches. */
const COUNTRIES = new Set(["australia", "new zealand", "united kingdom", "united states", "canada", "ireland", "singapore", "india"]);

export function tavilyBody(req: WebSearchRequest): Record<string, unknown> {
  const country = req.market?.trim().toLowerCase();
  return {
    query: req.query.slice(0, 400),
    max_results: Math.min(Math.max(req.max ?? 10, 1), 20),
    search_depth: "basic",
    topic: "general",
    ...(country && COUNTRIES.has(country) && { country }),
    ...(req.includeDomains?.length && { include_domains: req.includeDomains.slice(0, 300) }),
    ...(req.excludeDomains?.length && { exclude_domains: req.excludeDomains.slice(0, 150) }),
  };
}

export class TavilyWebSearch implements WebSearchProvider {
  readonly name = "tavily" as const;

  constructor(private readonly apiKey: string) {}

  async search(req: WebSearchRequest): Promise<WebResult[]> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(tavilyBody(req)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
    };
    return cleanResults(
      (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        ...(r.published_date && { publishedDate: r.published_date }),
        site: siteOf(r.url ?? ""),
      })),
    );
  }
}
