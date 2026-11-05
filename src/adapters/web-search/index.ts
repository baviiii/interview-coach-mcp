/**
 * Which web search answers, from WEB_SEARCH_PROVIDER:
 *   auto (default) → AWS if its Gateway URL is set, then Tavily if its key is
 *                    set — the first that finds something wins, the next one
 *                    backs it up when it fails or finds nothing
 *   aws | tavily   → only that one
 *   aws,tavily     → that order (or tavily,aws)
 *   off            → none
 * A provider named but not configured is skipped. Never throws.
 */

import { config } from "../../config.js";
import { AwsWebSearch } from "./aws-agentcore.js";
import type { WebSearchOutcome, WebSearchProvider, WebSearchRequest } from "./port.js";
import { TavilyWebSearch } from "./tavily.js";

export * from "./port.js";

export function providerOrder(setting: string | undefined): Array<"aws" | "tavily"> {
  const s = (setting ?? "auto").trim().toLowerCase();
  if (s === "off" || s === "none") return [];
  if (s === "auto" || !s) return ["aws", "tavily"];
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is "aws" | "tavily" => p === "aws" || p === "tavily")
    .filter((p, i, all) => all.indexOf(p) === i);
}

let cached: WebSearchProvider[] | null = null;

export function configuredProviders(): WebSearchProvider[] {
  if (cached) return cached;
  const ws = config.webSearch;
  cached = providerOrder(ws.provider).flatMap((name): WebSearchProvider[] => {
    if (name === "aws" && ws.awsGatewayUrl) return [new AwsWebSearch({ gatewayUrl: ws.awsGatewayUrl, region: ws.awsRegion })];
    if (name === "tavily" && ws.tavilyKey) return [new TavilyWebSearch(ws.tavilyKey)];
    return [];
  });
  return cached;
}

/** Ask each configured provider in order until one finds something. */
export async function webSearch(
  req: WebSearchRequest,
  providers: WebSearchProvider[] = configuredProviders(),
): Promise<WebSearchOutcome> {
  if (!providers.length) return { results: [], reason: "no web search configured" };
  const why: string[] = [];
  for (const p of providers) {
    try {
      const results = await p.search({ market: config.market, ...req });
      if (results.length) return { results, provider: p.name };
      why.push(`${p.name} found nothing`);
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[web-search] ${p.name} failed: ${message}`);
      why.push(`${p.name} failed`);
    }
  }
  return { results: [], reason: why.join("; ") };
}
