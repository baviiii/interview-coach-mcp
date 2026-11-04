/**
 * YouTube Data API v3 — candidate videos for the Study page's "Watch" row.
 *
 * Per skill: one search (100 quota units) and one details lookup (1 unit). The
 * free allowance is 10,000 units a day, so roughly 100 new skills a day. When
 * YouTube says the allowance is spent, asking stops for an hour (per Lambda
 * copy) rather than failing every request.
 *
 * YouTube's developer policies govern the results: titles and thumbnails are
 * shown as YouTube gives them and labelled as YouTube, nothing is kept past 30
 * days (we keep a day, in memory), and videos play in YouTube's own player.
 * Never throws — no key, a failure or a spent allowance is an empty list with
 * a reason. The request URL carries the key, so it is never logged.
 */

import { config } from "../../config.js";

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  description: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  likes: number | null;
  thumbnail: string;
  embeddable: boolean;
  madeForKids: boolean;
  /** "none" for an ordinary upload; "live" or "upcoming" for a stream. */
  live: string;
}

export interface VideoSearch {
  videos: YouTubeVideo[];
  /** Why there are none, when there are none for a reason other than "nothing matched". */
  reason?: string;
}

const API = "https://www.googleapis.com/youtube/v3";
const TIMEOUT_MS = 6000;
const PAUSE_MS = 60 * 60 * 1000;
let pausedUntil = 0;

const REGIONS: Record<string, string> = {
  australia: "AU",
  "new zealand": "NZ",
  "united kingdom": "GB",
  "united states": "US",
  canada: "CA",
  ireland: "IE",
  singapore: "SG",
  india: "IN",
};

/** The YouTube region for the learner's market, so local material ranks first. */
export function regionFor(market: string): string | undefined {
  return REGIONS[market.trim().toLowerCase()];
}

/** ISO 8601 duration ("PT1H2M3S") in seconds; 0 when unreadable, which the length rule then drops. */
export function isoSeconds(iso: string | undefined): number {
  const m = iso?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number];
  return d * 86_400 + h * 3600 + min * 60 + s;
}

type Got<T> = { ok: true; data: T } | { ok: false; reason: string };

async function get<T>(path: string, params: Record<string, string>): Promise<Got<T>> {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", config.youtube.apiKey!);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return { ok: true, data: (await res.json()) as T };
    const body = await res.text().catch(() => "");
    if (res.status === 403 && /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(body)) {
      pausedUntil = Date.now() + PAUSE_MS;
      return { ok: false, reason: "YouTube's daily allowance is used up" };
    }
    return { ok: false, reason: `YouTube answered ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `YouTube unreachable (${(err as Error).name})` };
  }
}

interface RawVideo {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    description?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string };
  status?: { embeddable?: boolean; madeForKids?: boolean };
}

function toVideo(v: RawVideo): YouTubeVideo | null {
  if (!v.id || !v.snippet?.title) return null;
  const t = v.snippet.thumbnails ?? {};
  return {
    id: v.id,
    title: v.snippet.title,
    channelTitle: v.snippet.channelTitle ?? "",
    description: v.snippet.description ?? "",
    publishedAt: v.snippet.publishedAt ?? "",
    durationSeconds: isoSeconds(v.contentDetails?.duration),
    views: Number(v.statistics?.viewCount ?? 0),
    likes: v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null,
    thumbnail: t.medium?.url ?? t.high?.url ?? t.default?.url ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    embeddable: v.status?.embeddable !== false,
    madeForKids: v.status?.madeForKids === true,
    live: v.snippet.liveBroadcastContent ?? "none",
  };
}

/** Up to `max` English, safe-search, embeddable videos for a query, with their length and counts. */
export async function searchVideos(query: string, opts: { market?: string; max?: number } = {}): Promise<VideoSearch> {
  if (!config.youtube.apiKey) return { videos: [], reason: "no YouTube key configured" };
  if (Date.now() < pausedUntil) return { videos: [], reason: "YouTube's daily allowance is used up" };
  const region = regionFor(opts.market ?? config.market);
  const search = await get<{ items?: Array<{ id?: { videoId?: string } }> }>("search", {
    part: "id",
    q: query,
    type: "video",
    maxResults: String(opts.max ?? 15),
    safeSearch: "strict",
    videoEmbeddable: "true",
    relevanceLanguage: "en",
    ...(region && { regionCode: region }),
  });
  if (!search.ok) return { videos: [], reason: search.reason };
  const ids = [
    ...new Set(
      (search.data.items ?? [])
        .map((i) => i.id?.videoId)
        .filter((id): id is string => typeof id === "string" && /^[\w-]{11}$/.test(id)),
    ),
  ];
  if (!ids.length) return { videos: [] };
  const details = await get<{ items?: RawVideo[] }>("videos", {
    part: "snippet,contentDetails,statistics,status",
    id: ids.join(","),
  });
  if (!details.ok) return { videos: [], reason: details.reason };
  return { videos: (details.data.items ?? []).map(toVideo).filter((v): v is YouTubeVideo => v !== null) };
}
