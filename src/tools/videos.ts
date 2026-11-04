import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { searchVideos, type YouTubeVideo } from "../adapters/research/youtube.js";
import { config } from "../config.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { videoPickPrompt } from "../domain/prompts.js";
import { shortlistVideos } from "../domain/video-quality.js";
import * as S from "../schemas.js";
import { err, ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * Videos for learning one skill: YouTube's results, cut down by hard quality
 * rules, then judged by the coach — does it really teach this skill, for this
 * job, by this market's rules. One skill per call, so a search (and YouTube's
 * small free allowance) is only spent on the skill a learner opens.
 *
 * Results are remembered for a day per Lambda copy and shared by everyone
 * asking about the same skill for the same job. They are not saved: YouTube's
 * policies cap how long its data may be kept (30 days), and a day in memory
 * keeps well inside that.
 */

export interface StudyVideo {
  skill: string;
  videoId: string;
  /** YouTube's own title and thumbnail, shown unchanged. */
  title: string;
  channelTitle: string;
  thumbnail: string;
  url: string;
  durationSeconds: number;
  views: number;
  publishedAt: string;
  /** The coach's line on what they'll learn — ours, shown beside YouTube's title. */
  why: string;
  source: "youtube";
}

export interface SkillVideos {
  skill: string;
  videos: StudyVideo[];
  /** "coach": the coach judged them; "ranked": by views and length only (the coach was unavailable). */
  pickedBy: "coach" | "ranked" | "none";
  reason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; result: SkillVideos }>();

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

function toStudyVideo(v: YouTubeVideo, skill: string, why: string): StudyVideo {
  return {
    skill,
    videoId: v.id,
    title: v.title,
    channelTitle: v.channelTitle,
    thumbnail: v.thumbnail,
    url: watchUrl(v.id),
    durationSeconds: v.durationSeconds,
    views: v.views,
    publishedAt: v.publishedAt,
    why,
    source: "youtube",
  };
}

/** The coach's picks, kept to known candidates, in its order, without repeats. */
export function applyPicks(shortlist: YouTubeVideo[], picks: unknown, skill: string, max: number): StudyVideo[] {
  const byId = new Map(shortlist.map((v) => [v.id, v]));
  const seen = new Set<string>();
  const out: StudyVideo[] = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    const v = byId.get(id);
    if (!v || seen.has(id)) continue;
    seen.add(id);
    out.push(toStudyVideo(v, skill, typeof p?.why === "string" ? p.why.trim() : ""));
    if (out.length === max) break;
  }
  return out;
}

export async function findSkillVideos(
  deps: Pick<ToolDeps, "horus" | "auth">,
  args: { field: string; skill: string; max?: number },
): Promise<SkillVideos> {
  const max = Math.min(args.max ?? 2, 3);
  const key = [config.market, args.field, args.skill, max].map((s) => String(s).trim().toLowerCase()).join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;

  const found = await searchVideos(`${args.skill} ${args.field}`);
  if (!found.videos.length) {
    const result: SkillVideos = { skill: args.skill, videos: [], pickedBy: "none", reason: found.reason ?? "no videos found" };
    // A real "nothing matched" is remembered; a failure or a spent allowance isn't, so it's tried again.
    if (!found.reason) cache.set(key, { at: Date.now(), result });
    return result;
  }

  const shortlist = shortlistVideos(found.videos);
  if (!shortlist.length) {
    const result: SkillVideos = { skill: args.skill, videos: [], pickedBy: "none", reason: "no video passed the quality rules" };
    cache.set(key, { at: Date.now(), result });
    return result;
  }

  try {
    const { system, user, schema } = videoPickPrompt({ field: args.field, skill: args.skill, videos: shortlist, max });
    const res = await deps.horus.infer<{ picks?: unknown }>({
      task: "study.pick_videos",
      system,
      messages: [{ role: "user", content: user }],
      schema,
      schemaName: "VideoPicks",
      model: "fast",
      temperature: 0.2,
      userRef: deps.auth.userId,
      userToken: deps.auth.jwt,
    });
    const result: SkillVideos = {
      skill: args.skill,
      videos: applyPicks(shortlist, res.data.picks, args.skill, max),
      pickedBy: "coach",
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch {
    // The coach couldn't judge them: still show the best by the rules, say so, and don't remember it.
    return {
      skill: args.skill,
      videos: shortlist.slice(0, max).map((v) => toStudyVideo(v, args.skill, "")),
      pickedBy: "ranked",
      reason: "picked by views and length — the coach's check was unavailable",
    };
  }
}

export function registerVideoTools(server: McpServer, deps: ToolDeps): void {
  const { auth } = deps;

  // ── find_skill_videos ───────────────────────────────────────────────────
  server.registerTool(
    "find_skill_videos",
    {
      title: "Find videos for learning one skill",
      description:
        "The best few YouTube videos for learning one skill for the learner's job: YouTube's results, filtered by length, views and age, then judged by the coach for whether they really teach the skill by the learner's market's rules. Empty (with a reason) when nothing is good enough.",
      inputSchema: S.skillVideosInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const field = args.field ?? ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title;
      if (!field) return err("Which job are these videos for? Pass `field`, or set a career goal first.");
      const result = await findSkillVideos(deps, { field, skill: args.skill, max: args.max });
      return ok({ ...result, field, _meta: { source: "YouTube", ...(result.reason && { reason: result.reason }) } });
    },
  );
}
