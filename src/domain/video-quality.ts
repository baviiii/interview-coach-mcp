/**
 * Which YouTube results are worth a learner's time, before the coach looks.
 *
 * Hard rules drop what can't be a good lesson: Shorts and clips under three
 * minutes, anything over thirty (a livestream or a full lecture series),
 * streams, children's content, videos that can't play inside Faircopy, ones
 * barely anyone has watched, and ones over ten years old. What's left is
 * ordered by a score — how widely watched, how well liked, how recent — and
 * the top few go to the coach, which decides whether each really teaches the
 * skill (see videoPickPrompt).
 */

import type { YouTubeVideo } from "../adapters/research/youtube.js";

export const MIN_SECONDS = 180;
export const MAX_SECONDS = 1800;
export const MIN_VIEWS = 1000;
/** Below this share of the most-watched candidate's views, a video is an outlier upload. */
export const RELATIVE_VIEWS = 0.02;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

function ageYears(v: YouTubeVideo, now: number): number {
  const t = Date.parse(v.publishedAt);
  return Number.isFinite(t) ? (now - t) / YEAR_MS : Infinity;
}

/** Candidates that pass the hard rules. */
export function usableVideos(videos: YouTubeVideo[], now = Date.now()): YouTubeVideo[] {
  const top = Math.max(0, ...videos.map((v) => v.views));
  return videos.filter(
    (v) =>
      v.embeddable &&
      !v.madeForKids &&
      v.live === "none" &&
      v.durationSeconds >= MIN_SECONDS &&
      v.durationSeconds <= MAX_SECONDS &&
      v.views >= MIN_VIEWS &&
      v.views >= top * RELATIVE_VIEWS &&
      ageYears(v, now) <= 10,
  );
}

/** Higher is better: reach (log of views), approval (likes per view), and freshness. */
export function videoScore(v: YouTubeVideo, now = Date.now()): number {
  const reach = Math.log10(v.views + 1);
  const approval = v.likes != null && v.views > 0 ? Math.min((v.likes / v.views) * 25, 1) : 0.3;
  const age = ageYears(v, now);
  const freshness = age <= 2 ? 1 : age <= 5 ? 0.5 : 0;
  return reach + approval + freshness;
}

/** The best few that pass the rules, best first. */
export function shortlistVideos(videos: YouTubeVideo[], n = 8, now = Date.now()): YouTubeVideo[] {
  return usableVideos(videos, now)
    .sort((a, b) => videoScore(b, now) - videoScore(a, now))
    .slice(0, n);
}

/** "12 min" / "1 h 5 min" — for the prompt and the card. */
export function lengthLabel(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
