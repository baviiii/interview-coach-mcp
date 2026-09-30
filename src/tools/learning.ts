import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FieldResearch } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { resolveFieldProfile } from "../context/field-profile.js";
import { rankResourcesPrompt, studyPlanPrompt, suggestResourcesPrompt } from "../domain/prompts.js";
import { drillDifficulty, nextReviewInDays, pickDrillSkill } from "../domain/spaced-repetition.js";
import { deriveSkillTargets } from "../domain/targets.js";
import * as S from "../schemas.js";
import type { LearnerContext } from "../types.js";
import { degradation, err, ok, researchMeta, researchSafely, type Degradation } from "./_util.js";
import type { ToolDeps } from "./interview.js";

interface Candidate {
  id: string;
  title: string;
  type: string;
  difficulty?: string;
  provider?: string;
  /** Where the row came from — a real catalogue row or a researched mention. */
  source: "catalog" | "community";
  url?: string;
  stat?: string | null;
}

export interface RankedResource extends Candidate {
  priority: number;
  whyRecommended: string;
}

export interface ResourceResult {
  resources: RankedResource[];
  /** True when nothing real backed these — model-suggested moves, no sources. */
  unsourced: boolean;
  research: FieldResearch;
  reasons: string[];
}

/**
 * The learner's field, for research purposes. The old code passed the first
 * *skill name* here ("System Design"), which researches the wrong thing and
 * returns little — and since researched resources are the only fallback when
 * the resources table is empty, that fed straight into "nothing shows up".
 */
function fieldFor(ctx: LearnerContext, explicit?: string): string {
  return explicit ?? ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title ?? "their field";
}

/**
 * Rank learning resources for a learner, from whatever actually exists:
 * catalogue rows first, community-researched material next, and a clearly
 * flagged model suggestion only when both are empty. Shared by
 * `rank_learning_resources` and `get_learning_pathway` so they can never
 * disagree about what to study.
 */
async function rankResources(
  deps: ToolDeps,
  ctx: LearnerContext,
  args: { skills?: string[]; skillIds?: string[]; goal?: string; field?: string; maxResults?: number },
): Promise<ResourceResult> {
  const { auth, horus } = deps;
  const max = args.maxResults ?? 8;
  const reasons: string[] = [];
  const skills = args.skills?.length ? args.skills : ctx.weakSkills.map((s) => s.name);
  const field = fieldFor(ctx, args.field ?? args.goal);

  // 1. The deployment's own catalogue.
  let catalog: Candidate[] = [];
  try {
    let q = auth.db
      .from("learning_resources")
      .select("id, title, resource_type, difficulty, provider, skill_tags")
      .eq("is_active", true)
      .limit(max);
    if (args.skillIds?.length) q = q.overlaps("skill_tags", args.skillIds);
    const { data, error } = await q;
    if (error) reasons.push(`learning_resources unreadable (${error.message})`);
    catalog = (data ?? []).map((r: any) => ({
      id: r.id,
      title: r.title,
      type: r.resource_type,
      difficulty: r.difficulty ?? undefined,
      provider: r.provider ?? undefined,
      source: "catalog" as const,
    }));
  } catch {
    reasons.push("learning_resources unreadable");
  }
  if (catalog.length === 0) reasons.push("no rows in learning_resources — falling back to researched material");

  // 2. What the field's community actually recommends (free, cited).
  const research = await researchSafely(deps.research, {
    field,
    role: ctx.goal?.targetRole,
    intents: ["resource"],
    max: Math.max(max, 6),
  });
  const community: Candidate[] = research.resources.map((s, i) => ({
    id: `research:${i + 1}`,
    title: s.text.length > 120 ? `${s.text.slice(0, 119)}…` : s.text,
    type: "community",
    provider: s.sourceLabel,
    url: s.sourceUrl,
    stat: s.stat ?? null,
    source: "community" as const,
  }));
  if (research.partial) reasons.push("some research sources were unavailable (see _meta.research)");

  const candidates = [...catalog, ...community].slice(0, Math.max(max, 8));

  // 3. Nothing real to rank — say what to do anyway, clearly unsourced.
  if (candidates.length === 0) {
    reasons.push("no catalogue rows and no researched resources — returning unsourced suggestions");
    const { system, user } = suggestResourcesPrompt({ field, skills, goal: args.goal, count: Math.min(max, 5), ctx });
    const res = await horus.infer<{
      resources?: Array<{ title?: string; type?: string; whyRecommended?: string; priority?: number; howToFind?: string }>;
    }>({
      task: "study.suggest_resources",
      system,
      messages: [{ role: "user", content: user }],
      model: "fast",
      userRef: auth.userId,

      userToken: auth.jwt,
    });
    const suggested = (res.data.resources ?? []).slice(0, max).map((r, i) => ({
      id: `suggested:${i + 1}`,
      title: r.title ?? "Untitled",
      type: r.type ?? "practice",
      provider: r.howToFind,
      source: "community" as const,
      priority: r.priority ?? i + 1,
      whyRecommended: r.whyRecommended ?? `Targets ${skills[0] ?? field}.`,
    }));
    return { resources: suggested, unsourced: true, research, reasons };
  }

  // 4. Rank whatever we have for THIS learner.
  let ranked: Array<{ id: string; priority: number; whyRecommended: string }> = [];
  try {
    const { system, user } = rankResourcesPrompt({ goal: args.goal, skills, candidates, ctx });
    const res = await horus.infer<{ ranked?: typeof ranked }>({
      task: "study.rank_resources",
      system,
      messages: [{ role: "user", content: user }],
      model: "fast",
      userRef: auth.userId,

      userToken: auth.jwt,
    });
    ranked = res.data.ranked ?? [];
  } catch {
    reasons.push("ranking model call failed — falling back to source order");
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const fromModel = ranked
    .map((r) => {
      const c = byId.get(r.id);
      return c ? { ...c, priority: r.priority, whyRecommended: r.whyRecommended } : null;
    })
    .filter((x): x is RankedResource => x !== null);

  // The model may rank only some of them; keep the rest rather than dropping.
  const missing = candidates
    .filter((c) => !fromModel.some((r) => r.id === c.id))
    .map((c, i) => ({
      ...c,
      priority: fromModel.length + i + 1,
      whyRecommended:
        c.source === "community"
          ? "Recommended by people working in this field."
          : `Targets ${skills[0] ?? "your goal"}.`,
    }));

  return {
    resources: [...fromModel, ...missing].slice(0, max),
    unsourced: false,
    research,
    reasons,
  };
}

export function registerLearningTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus } = deps;

  // ── rank_learning_resources ─────────────────────────────────────────────
  server.registerTool(
    "rank_learning_resources",
    {
      title: "Rank learning resources with reasons",
      description:
        "Ranks learning resources for the learner's weak skills / stated goal, each with a 'whyRecommended' and priority. Merges the deployment's catalogue with resources the field's community actually recommends, and never returns an empty list.",
      inputSchema: S.rankResourcesInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const result = await rankResources(deps, ctx, args);
      const skills = args.skills ?? ctx.weakSkills.map((s) => s.name);

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "resource",
            title: `Resources for ${skills[0] ?? fieldFor(ctx, args.goal)}`,
            description: args.goal ?? null,
            ai_reasoning: JSON.stringify(result.resources).slice(0, 4000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({
        resources: result.resources,
        // Kept for backwards compatibility with the existing UI — the same
        // community items now also appear inline in `resources`. `why` is the
        // old field name, kept alongside the new one.
        communityResources: result.resources
          .filter((r) => r.source === "community")
          .map((r) => ({ ...r, why: r.whyRecommended })),
        unsourced: result.unsourced,
        recommendationId,
        _meta: { research: researchMeta(result.research), degraded: degradation(result.reasons) },
      });
    },
  );

  // ── get_learning_pathway ────────────────────────────────────────────────
  server.registerTool(
    "get_learning_pathway",
    {
      title: "Get the learner's full learning pathway",
      description:
        "One call for the whole learning side: what to work on (from the last interview's debrief when there is one), a week-by-week plan, ranked resources, the drill that's due, and what the next mock should target. Works for a brand-new learner with an empty database.",
      inputSchema: S.learningPathwayInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const reasons: string[] = [];
      const field = fieldFor(ctx, args.field);
      const weeks = args.weeks ?? 4;
      const hoursPerWeek = args.hoursPerWeek ?? 5;

      // What the last mock interview said to work on — this is the link that
      // keeps interviews and the pathway pointed at the same gaps.
      let focus: { skills: string[]; questionTypes?: string[]; why?: string } | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .select("ai_reasoning, created_at")
          .eq("user_id", auth.userId)
          .eq("recommendation_type", "practice_area")
          .eq("status", "active")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const parsed = data?.ai_reasoning ? JSON.parse(data.ai_reasoning) : null;
        if (parsed && Array.isArray(parsed.skills) && parsed.skills.length > 0) focus = parsed;
      } catch {
        /* best-effort — the pathway works without a prior interview */
      }
      if (!focus) reasons.push("no completed interview yet — pathway targets the skill matrix instead of a debrief");

      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field,
          role: ctx.goal?.targetRole,
          intents: ["resource", "experience"],
          max: 4,
        }),
        // The real field only — never the "their field" placeholder.
        resolveFieldProfile(horus, args.field ?? ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title, {
          role: ctx.goal?.targetRole,
          userRef: auth.userId,
          userToken: auth.jwt,
        }),
      ]);

      const derived = deriveSkillTargets({
        ctx,
        skills: args.skills ?? focus?.skills,
        field,
        research,
        profile,
      });
      if (derived.targets.length === 0) {
        return err(
          "Nothing to build a pathway from yet: no tracked skills, no career goal and no field. Set a career goal (set_career_goal) or pass `field`.",
        );
      }
      if (derived.note) reasons.push(derived.note);

      // Plan + resources in parallel — both are independent model calls.
      const [planRes, resourceResult] = await Promise.all([
        (async () => {
          const { system, user } = studyPlanPrompt({
            weeks,
            hoursPerWeek,
            skillTargets: derived.targets,
            resourceCandidates: "",
            goal: args.goal ?? ctx.goal?.targetRole,
            ctx,
            research,
          });
          return horus.infer({
            task: "study.build_plan",
            system,
            messages: [{ role: "user", content: user }],
            model: "deep",
            userRef: auth.userId,

            userToken: auth.jwt,
          });
        })(),
        rankResources(deps, ctx, {
          skills: derived.targets.map((t) => t.skill),
          goal: args.goal ?? ctx.goal?.targetRole,
          field,
          maxResults: 6,
        }),
      ]);
      reasons.push(...resourceResult.reasons);

      // The drill that's due — deterministic, no model call needed.
      const due = pickDrillSkill(ctx.skills);
      const nextDrill = due
        ? {
            skill: due.skill.name,
            difficulty: drillDifficulty(due.skill.proficiency),
            whyNow: due.whyNow,
            nextReviewInDays: nextReviewInDays(due.skill.proficiency),
          }
        : {
            skill: derived.targets[0]!.skill,
            difficulty: drillDifficulty(derived.targets[0]!.from),
            whyNow: "starting point — nothing has been tested yet",
            nextReviewInDays: nextReviewInDays(derived.targets[0]!.from),
          };

      const pathway = {
        field,
        targetRole: ctx.goal?.targetRole ?? null,
        focus: {
          skills: derived.targets.map((t) => t.skill),
          source: derived.source,
          why: focus?.why ?? derived.note ?? "Your lowest-proficiency tested skills.",
          fromLastInterview: focus !== null,
        },
        targets: derived.targets,
        plan: planRes.data,
        resources: resourceResult.resources,
        unsourcedResources: resourceResult.unsourced,
        nextDrill,
        nextMock: {
          field,
          seniority: ctx.goal?.seniority ?? ctx.targetSeniority ?? null,
          focusAreas: derived.targets.slice(0, 3).map((t) => t.skill),
          questionTypes: focus?.questionTypes ?? null,
          why: focus
            ? "Targets exactly what your last mock exposed."
            : "A mock interview replaces these estimated targets with measured ones.",
        },
      };

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "pathway",
            title: `Learning pathway: ${derived.targets.map((t) => t.skill).slice(0, 3).join(", ")}`,
            description: `${weeks}w · ${hoursPerWeek} h/week · ${field}`,
            ai_reasoning: JSON.stringify(pathway).slice(0, 8000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({
        pathway,
        recommendationId,
        _meta: {
          model: planRes.model,
          research: researchMeta(research),
          degraded: degradation(reasons),
        },
      });
    },
  );

  // ── explain_recommendation ──────────────────────────────────────────────
  server.registerTool(
    "explain_recommendation",
    {
      title: "Explain why something was recommended",
      description: "Surfaces the stored AI reasoning behind a recommendation. Builds trust in the coach.",
      inputSchema: S.explainInput,
    },
    async (args) => {
      let row: any = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .select("recommendation_type, title, description, ai_reasoning, confidence_score, created_at")
          .eq("id", args.recommendationId)
          // Defense in depth: RLS should already scope this, but never rely on
          // a single layer for someone else's coaching history.
          .eq("user_id", auth.userId)
          .maybeSingle();
        row = data;
      } catch {
        /* best-effort */
      }
      if (!row) return err("Recommendation not found or not accessible.");
      return ok({
        recommendationId: args.recommendationId,
        type: row.recommendation_type,
        title: row.title,
        description: row.description,
        reasoning: row.ai_reasoning,
        confidence: row.confidence_score,
        createdAt: row.created_at,
      });
    },
  );
}

export type { Degradation };
