import { config } from "../../config.js";
import { httpJson } from "./util.js";

/**
 * Low-level Reddit search. Reddit's anonymous `search.json` is increasingly
 * gated (403 from datacenter IPs, any User-Agent), so when FREE app credentials
 * are configured we use the reliable app-only OAuth endpoint
 * (`oauth.reddit.com`); otherwise we try anonymous and tolerate an empty result.
 * Either way this never throws — callers treat [] as "no evidence".
 */
const UA = config.reddit.userAgent;

export interface RedditPost {
  title: string;
  selftext?: string;
  ups?: number;
  permalink: string;
  subreddit: string;
  over_18?: boolean;
}

interface RedditSearch {
  data?: { children?: Array<{ data: RedditPost }> };
}

/* ── app-only OAuth (free; only when creds are present) ────────────────────── */

let cachedToken: { value: string; expEpochMs: number } | null = null;

async function appOnlyToken(): Promise<string | null> {
  const { clientId, clientSecret } = config.reddit;
  if (!clientId || !clientSecret) return null;
  if (cachedToken && Date.now() < cachedToken.expEpochMs) return cachedToken.value;
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) return null;
    cachedToken = {
      value: json.access_token,
      expEpochMs: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
    };
    return cachedToken.value;
  } catch {
    return null;
  }
}

export async function searchReddit(query: string, limit = 6, time: "year" | "all" = "year"): Promise<RedditPost[]> {
  const token = await appOnlyToken();
  const base = token ? "https://oauth.reddit.com/search" : "https://www.reddit.com/search.json";
  const url = `${base}?q=${encodeURIComponent(query)}&sort=top&t=${time}&limit=${limit}`;
  const headers: Record<string, string> = { "User-Agent": UA };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const json = await httpJson<RedditSearch>(url, { headers });
  if (!json) return [];
  return (json.data?.children ?? [])
    .map((c) => c.data)
    .filter((p): p is RedditPost => Boolean(p?.permalink && p.title) && !p.over_18)
    .sort((a, b) => (b.ups ?? 0) - (a.ups ?? 0));
}

export function redditUrl(p: RedditPost): string {
  return `https://www.reddit.com${p.permalink}`;
}
