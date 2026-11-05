/**
 * Web search — one seam, any provider. The coach asks for results; which
 * search engine answers is a setting (WEB_SEARCH_PROVIDER), so Tavily and
 * AWS's AgentCore Web Search are interchangeable, and either can back the
 * other up. Both return the same shape, so nothing past this seam knows or
 * cares which one ran.
 */

export interface WebResult {
  title: string;
  url: string;
  /** The provider's passage from the page that matched. */
  snippet: string;
  publishedDate?: string;
  /** The site, e.g. "reddit.com" — shown beside every result, as both providers' terms want the source credited. */
  site: string;
}

export interface WebSearchRequest {
  /** Plain words; trimmed to what each provider accepts. */
  query: string;
  max?: number;
  /** Only results from these sites (subdomains included). */
  includeDomains?: string[];
  /** Never results from these sites. */
  excludeDomains?: string[];
  /** The learner's market, so local results rank first where the provider can. */
  market?: string;
}

export interface WebSearchProvider {
  readonly name: "tavily" | "aws";
  /** Throws on failure; the composite decides what to do next. */
  search(req: WebSearchRequest): Promise<WebResult[]>;
}

export interface WebSearchOutcome {
  results: WebResult[];
  /** Which provider answered. */
  provider?: "tavily" | "aws";
  /** Why there are none, when there are none. */
  reason?: string;
}

/** "https://www.reddit.com/r/x" → "reddit.com". */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Results with a real https link and a title, one per link. */
export function cleanResults(results: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (!r.title.trim() || !/^https:\/\//i.test(r.url) || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}
