import type { GroundedResource, GroundingPort, ProofKind, ProofSource } from "./port.js";

/**
 * HackerNewsGrounding — REAL, key-free community proof via the HN Algolia API.
 * Returns actual stories with real points + comment counts and links (HN often
 * surfaces proven guides, e.g. interviewing.io). Reachable without OAuth, unlike
 * Reddit's now-gated endpoint — so this is the default "real" grounding source.
 *
 * Queries are driven off the SKILL (reliable hits) and rotate across the top
 * results so multiple tips don't all cite the same thread.
 */
const TTL_MS = 10 * 60 * 1000;
const STOP = new Set([
  "with", "your", "that", "this", "from", "have", "always", "first", "then", "when",
  "what", "which", "about", "into", "they", "them", "will", "should", "could", "being",
  "because", "their", "interview", "interviewer", "answer", "question",
]);

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

export class HackerNewsGrounding implements GroundingPort {
  private cache = new Map<string, { at: number; hits: HnHit[] }>();

  private async hitsFor(query: string): Promise<HnHit[]> {
    const cached = this.cache.get(query);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.hits;
    const hits = await search(query, 6);
    this.cache.set(query, { at: Date.now(), hits });
    return hits;
  }

  async findEvidence(req: { claim: string; skill?: string; preferKind?: ProofKind }): Promise<ProofSource | null> {
    const query = `${req.skill ?? keywords(req.claim)} interview`.trim();
    const hits = await this.hitsFor(query);
    if (hits.length === 0) return null;
    // Rotate by claim so distinct tips cite distinct threads when possible.
    const pick = hits[hashStr(req.claim) % hits.length];
    if (!pick) return null;
    return { kind: "community", label: `Hacker News — ${truncate(pick.title, 60)}`, stat: statOf(pick), url: itemUrl(pick) };
  }

  async findResources(req: { query: string; skills: string[]; max?: number }): Promise<GroundedResource[]> {
    const max = req.max ?? 6;
    const hits = (await search(`${req.skills[0] ?? req.query} interview`, max + 4))
      .filter((h) => Boolean(h.url) && (h.points ?? 0) >= 20)
      .slice(0, max);
    return hits.map((h) => ({
      title: truncate(h.title, 90),
      provider: domainOf(h.url!),
      type: "Article",
      url: h.url!,
      why: `Community-vetted for ${req.skills[0] ?? "your goal"}.`,
      proof: { kind: "community" as ProofKind, label: "Hacker News", stat: statOf(h), url: itemUrl(h) },
    }));
  }
}

async function search(query: string, n: number): Promise<HnHit[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${n}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as HnResponse;
    return (json.hits ?? [])
      .filter((h) => Boolean(h?.title))
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  } catch {
    return [];
  }
}

function statOf(h: HnHit): string {
  return `${h.points ?? 0} pts · ${h.num_comments ?? 0} comments`;
}
function itemUrl(h: HnHit): string {
  return `https://news.ycombinator.com/item?id=${h.objectID}`;
}
function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "Hacker News";
  }
}
function keywords(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 4)
    .join(" ");
}
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
