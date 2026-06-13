import type { GroundedResource, GroundingPort, ProofKind, ProofSource } from "./port.js";

/**
 * RedditGrounding — REAL community proof. Queries Reddit's public search and
 * returns actual threads with real upvote counts + permalinks. No API key
 * needed (just a User-Agent). The model proposes a tip; this proves it with a
 * real post, or returns null (→ the tip is flagged unverified).
 */
const UA = "interview-coach-mcp/0.1 (proof grounding)";
const TTL_MS = 10 * 60 * 1000;
const STOP = new Set([
  "with", "your", "that", "this", "from", "have", "always", "first", "then", "when",
  "what", "which", "about", "into", "they", "them", "will", "should", "could", "being",
  "because", "their", "там", "interviewer", "interview", "answer", "question",
]);

interface RedditPost {
  title: string;
  ups?: number;
  permalink: string;
  subreddit: string;
  over_18?: boolean;
}
interface RedditSearch {
  data?: { children?: Array<{ data: RedditPost }> };
}

export class RedditGrounding implements GroundingPort {
  private cache = new Map<string, { at: number; val: ProofSource | null }>();

  async findEvidence(req: { claim: string; skill?: string; preferKind?: ProofKind }): Promise<ProofSource | null> {
    const query = `${keywords(req.claim)} ${req.skill ?? ""} interview`.trim();
    const cached = this.cache.get(query);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.val;

    const post = await searchTop(query, 5);
    const val: ProofSource | null = post
      ? {
          kind: "reddit",
          label: `r/${post.subreddit} — ${truncate(post.title, 64)}`,
          stat: `${fmtUps(post.ups)} upvotes`,
          url: `https://www.reddit.com${post.permalink}`,
        }
      : null;
    this.cache.set(query, { at: Date.now(), val });
    return val;
  }

  async findResources(req: { query: string; skills: string[]; max?: number }): Promise<GroundedResource[]> {
    const max = req.max ?? 6;
    const query = `${req.skills[0] ?? req.query} interview prep resources`;
    const posts = await searchMany(query, max + 4);
    return posts
      .filter((p) => (p.ups ?? 0) > 20)
      .slice(0, max)
      .map((p) => ({
        title: truncate(p.title, 90),
        provider: `r/${p.subreddit}`,
        type: "Discussion",
        url: `https://www.reddit.com${p.permalink}`,
        why: `Community-vetted for ${req.skills[0] ?? "your goal"}.`,
        proof: {
          kind: "reddit" as ProofKind,
          label: `r/${p.subreddit}`,
          stat: `${fmtUps(p.ups)} upvotes`,
          url: `https://www.reddit.com${p.permalink}`,
        },
      }));
  }
}

async function searchMany(query: string, limit: number): Promise<RedditPost[]> {
  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&t=year&limit=${limit}`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const json = (await res.json()) as RedditSearch;
    return (json.data?.children ?? [])
      .map((c) => c.data)
      .filter((p): p is RedditPost => Boolean(p) && !p.over_18)
      .sort((a, b) => (b.ups ?? 0) - (a.ups ?? 0));
  } catch {
    return [];
  }
}

async function searchTop(query: string, limit: number): Promise<RedditPost | undefined> {
  return (await searchMany(query, limit))[0];
}

function keywords(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 6)
    .join(" ");
}

function fmtUps(n?: number): string {
  const v = n ?? 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
