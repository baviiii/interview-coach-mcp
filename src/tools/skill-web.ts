import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { webSearch, type WebResult } from "../adapters/web-search/index.js";
import { config } from "../config.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { webPickPrompt } from "../domain/prompts.js";
import {
  DISCUSSION_SITES,
  GUIDE_EXCLUDED_SITES,
  discussionQuery,
  guideQuery,
} from "../domain/web-sources.js";
import * as S from "../schemas.js";
import { err, ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";
import { allowNewSearch } from "./videos.js";

/**
 * Study's two web rows for one skill: "What people say" (practitioners'
 * discussions, from discussion sites only) and "Courses & guides" (pages that
 * teach it, from the rest of the web minus junk). Two searches through the
 * provider-agnostic web search, then the coach keeps what's worth opening.
 *
 * Like the videos: one skill per call, remembered a day per Lambda copy and
 * shared by everyone asking about that skill for that job, and a few new
 * searches an hour per learner. Each result keeps its link and site, as the
 * providers' terms require the source to be shown.
 */

export interface WebPick {
  title: string;
  url: string;
  site: string;
  why: string;
  publishedDate?: string;
}

export interface SkillWeb {
  skill: string;
  discussions: WebPick[];
  guides: WebPick[];
  provider?: "tavily" | "aws";
  /** "coach": judged by the coach; "ranked": the provider's order (the coach was unavailable); "none": nothing to show. */
  pickedBy: "coach" | "ranked" | "none";
  reason?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED = 500;
const cache = new Map<string, { at: number; result: SkillWeb }>();

function remember(key: string, result: SkillWeb): void {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), result });
}

const toPick = (r: WebResult, why: string): WebPick => ({
  title: r.title,
  url: r.url,
  site: r.site,
  why,
  ...(r.publishedDate && { publishedDate: r.publishedDate }),
});

/** The coach's picks ("D2", "G1"), kept to real candidates, in its order, without repeats. */
export function applyWebPicks(candidates: WebResult[], prefix: "D" | "G", picks: unknown, max: number): WebPick[] {
  const out: WebPick[] = [];
  const seen = new Set<number>();
  for (const p of Array.isArray(picks) ? picks : []) {
    const m = typeof p?.id === "string" ? p.id.trim().toUpperCase().match(/^([DG])(\d+)$/) : null;
    if (!m || m[1] !== prefix) continue;
    const i = Number(m[2]) - 1;
    const r = candidates[i];
    if (!r || seen.has(i)) continue;
    seen.add(i);
    out.push(toPick(r, typeof p?.why === "string" ? p.why.trim() : ""));
    if (out.length === max) break;
  }
  return out;
}

export async function findSkillWeb(
  deps: Pick<ToolDeps, "horus" | "auth">,
  args: { field: string; skill: string; max?: number },
): Promise<SkillWeb> {
  const max = Math.min(args.max ?? 3, 5);
  const key = [config.market, args.field, args.skill, max].map((s) => String(s).trim().toLowerCase()).join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.result;
  if (!allowNewSearch(`web:${deps.auth.userId}`)) {
    return { skill: args.skill, discussions: [], guides: [], pickedBy: "none", reason: "too many new searches this hour — try again later" };
  }

  const [talk, read] = await Promise.all([
    webSearch({ query: discussionQuery(args.skill, args.field), max: 10, includeDomains: DISCUSSION_SITES }),
    webSearch({ query: guideQuery(args.skill, args.field), max: 10, excludeDomains: GUIDE_EXCLUDED_SITES }),
  ]);
  const discussions = talk.results.slice(0, 8);
  const guides = read.results.slice(0, 8);
  const provider = talk.provider ?? read.provider;

  if (!discussions.length && !guides.length) {
    const reason = talk.reason ?? read.reason ?? "nothing found";
    const result: SkillWeb = { skill: args.skill, discussions: [], guides: [], pickedBy: "none", reason };
    // Only a real "nothing found" is remembered; a failure is tried again next time.
    if (!/failed|configured/.test(reason)) remember(key, result);
    return result;
  }

  try {
    const { system, user, schema } = webPickPrompt({ field: args.field, skill: args.skill, discussions, guides, max });
    const res = await deps.horus.infer<{ discussions?: unknown; guides?: unknown }>({
      task: "study.pick_web",
      system,
      messages: [{ role: "user", content: user }],
      schema,
      schemaName: "WebPicks",
      model: "fast",
      temperature: 0.2,
      userRef: deps.auth.userId,
      userToken: deps.auth.jwt,
    });
    const result: SkillWeb = {
      skill: args.skill,
      discussions: applyWebPicks(discussions, "D", res.data.discussions, max),
      guides: applyWebPicks(guides, "G", res.data.guides, max),
      ...(provider && { provider }),
      pickedBy: "coach",
    };
    remember(key, result);
    return result;
  } catch {
    // The coach couldn't judge them: show the provider's top few, say so, and don't remember it.
    return {
      skill: args.skill,
      discussions: discussions.slice(0, max).map((r) => toPick(r, "")),
      guides: guides.slice(0, max).map((r) => toPick(r, "")),
      ...(provider && { provider }),
      pickedBy: "ranked",
      reason: "in the search engine's order — the coach's check was unavailable",
    };
  }
}

export function registerSkillWebTools(server: McpServer, deps: ToolDeps): void {
  const { auth } = deps;

  // ── find_skill_web_resources ────────────────────────────────────────────
  server.registerTool(
    "find_skill_web_resources",
    {
      title: "Find discussions, courses and guides for one skill",
      description:
        "For one skill and the learner's job: practitioners' discussions (discussion sites only) and courses or guides that teach it (the wider web minus junk), found with the configured web search (AWS or Tavily) and judged by the coach. Every result keeps its link and site. Empty, with a reason, when nothing is good enough.",
      inputSchema: S.skillWebInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const field = args.field ?? ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title;
      if (!field) return err("Which job is this for? Pass `field`, or set a career goal first.");
      const result = await findSkillWeb(deps, { field, skill: args.skill, max: args.max });
      return ok({
        ...result,
        field,
        _meta: { ...(result.provider && { source: result.provider }), ...(result.reason && { reason: result.reason }) },
      });
    },
  );
}
