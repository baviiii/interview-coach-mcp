import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FieldResearch } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { resolveFieldProfile } from "../context/field-profile.js";
import { finishedUrls, normaliseUrl, statusFor, type ResourceStatus } from "../context/resources.js";
import { saveResult } from "../context/saved-results.js";
import { rankResourcesPrompt, studyPlanPrompt, suggestResourcesPrompt } from "../domain/prompts.js";
import { drillDifficulty, nextReviewInDays, pickDrillSkill } from "../domain/spaced-repetition.js";
import { deriveSkillTargets } from "../domain/targets.js";
import * as S from "../schemas.js";
import type { LearnerContext } from "../types.js";
import { degradation, err, ok, researchMeta, researchSafely, techJob, type Degradation } from "./_util.js";
import type { ToolDeps } from "./interview.js";
import { officialTrainingLinks, withCheckedLinks, type LinkKind, type OfficialTrainingLink } from "./suggested-links.js";

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
  /** The target skill it builds: finishing it credits this skill. */
  forSkill?: string;
  /** The learner's own status, when they've saved or started it. */
  myStatus?: ResourceStatus;
  /** For the coach's own suggestions: whether the link is the page it named (checked) or a search for it. */
  linkKind?: LinkKind;
}

export interface ResourceResult {
  resources: RankedResource[];
  /** True when nothing real backed these — the coach's own picks (each link still opens). */
  unsourced: boolean;
  /** Where to find accredited training for the skills that call for it (Australia). */
  officialTraining: OfficialTrainingLink[];
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
  args: {
    skills?: string[];
    skillIds?: string[];
    goal?: string;
    field?: string;
    maxResults?: number;
    /** A software or IT job (from its field profile): only then are Hacker News links any use. */
    technical?: boolean;
  },
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
  //
  // Not the knowledge index: its documents are job reports, strategies and
  // application guides — right for tips and interview prep, but nothing to
  // learn a skill from. And Hacker News only for tech jobs: its search is
  // "<job> interview", which for a nurse turns up unrelated tech stories.
  const research = await researchSafely(deps.research, {
    field,
    role: ctx.goal?.targetRole,
    intents: ["resource"],
    max: Math.max(max, 6),
  });
  const usable = research.resources.filter((s) => args.technical || s.sourceLabel !== "Hacker News");
  const community: Candidate[] = usable.map((s, i) => ({
    id: `research:${i + 1}`,
    title: s.text.length > 120 ? `${s.text.slice(0, 119)}…` : s.text,
    type: "community",
    provider: s.sourceLabel,
    url: s.sourceUrl,
    stat: s.stat ?? null,
    source: "community" as const,
  }));
  if (research.partial) reasons.push("some research sources were unavailable (see _meta.research)");

  // What they've already finished is never recommended again.
  const done = finishedUrls(ctx.resources);
  const doneIds = new Set((ctx.resources ?? []).filter((r) => r.status === "completed").map((r) => r.resourceId));
  const candidates = [...catalog, ...community]
    .filter((c) => !doneIds.has(c.id) && !(c.url && done.has(normaliseUrl(c.url)!)))
    .slice(0, Math.max(max, 8));

  // 3. Nothing real to rank — the coach names what a practitioner would, and
  // every one gets a link that opens: the page it named if that loads, else a
  // web search for it. Plus where to find accredited training, for the skills
  // that are normally learned that way.
  if (candidates.length === 0) {
    reasons.push("no catalogue rows and no researched resources — returning the coach's own suggestions");
    const { system, user, schema } = suggestResourcesPrompt({
      field,
      skills,
      goal: args.goal,
      count: Math.min(max, 5),
      ctx,
      accreditedTraining: true,
    });
    const res = await horus.infer<{
      resources?: Array<{
        title?: string;
        type?: string;
        forSkill?: unknown;
        whyRecommended?: string;
        priority?: number;
        howToFind?: string;
        url?: unknown;
        search?: unknown;
      }>;
      accreditedTraining?: unknown;
    }>({
      task: "study.suggest_resources",
      expect: ["resources"],
      schema,
      schemaName: "ResourceSuggestions",
      system,
      messages: [{ role: "user", content: user }],
      model: "fast",
      userRef: auth.userId,

      userToken: auth.jwt,
    });
    const named = (Array.isArray(res.data.resources) ? res.data.resources : [])
      .filter((r) => typeof r.title === "string" && r.title.trim())
      .slice(0, max)
      .map((r) => ({ ...r, title: r.title!.trim() }));
    const linked = await withCheckedLinks(named, field);
    const suggested = linked
      .filter((r) => !done.has(normaliseUrl(r.url)!))
      .map((r, i): RankedResource => {
        const resource: RankedResource = {
          id: `suggested:${i + 1}`,
          title: r.title,
          type: r.type ?? "practice",
          provider: r.howToFind,
          source: "community",
          url: r.url,
          linkKind: r.linkKind,
          priority: r.priority ?? i + 1,
          whyRecommended: r.whyRecommended ?? `Targets ${skills[0] ?? field}.`,
          forSkill: targetSkill(r.forSkill, skills),
        };
        const myStatus = statusFor(ctx.resources, r.url);
        return myStatus ? { ...resource, myStatus } : resource;
      });
    return {
      resources: suggested,
      unsourced: true,
      officialTraining: officialTrainingLinks(res.data.accreditedTraining),
      research,
      reasons,
    };
  }

  // 4. Rank whatever we have for THIS learner.
  let ranked: Array<{ id: string; priority: number; whyRecommended: string; forSkill?: unknown }> = [];
  try {
    const { system, user } = rankResourcesPrompt({ goal: args.goal, skills, candidates, ctx });
    const res = await horus.infer<{ ranked?: typeof ranked }>({
      task: "study.rank_resources",
      expect: ["ranked"],
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
  const fromModel: RankedResource[] = [];
  for (const r of ranked) {
    const c = byId.get(r.id);
    if (c) fromModel.push({ ...c, priority: r.priority, whyRecommended: r.whyRecommended, forSkill: targetSkill(r.forSkill, skills) });
  }

  // The model may rank only some of them; keep the rest rather than dropping.
  const missing: RankedResource[] = candidates
    .filter((c) => !fromModel.some((r) => r.id === c.id))
    .map((c, i) => ({
      ...c,
      priority: fromModel.length + i + 1,
      forSkill: skills[0],
      whyRecommended:
        c.source === "community"
          ? "Recommended by people working in this field."
          : `Targets ${skills[0] ?? "your goal"}.`,
    }));

  return {
    resources: [...fromModel, ...missing].slice(0, max).map((r): RankedResource => {
      const myStatus = statusFor(ctx.resources, r.url);
      return myStatus ? { ...r, myStatus } : r;
    }),
    unsourced: false,
    officialTraining: [],
    research,
    reasons,
  };
}

/** The ranker's skill for a resource, if it's one of the targets; otherwise the first target. */
function targetSkill(raw: unknown, skills: string[]): string | undefined {
  const said = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return skills.find((s) => s.toLowerCase() === said) ?? skills[0];
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
      // The real field only (a goal can be any sentence); cached a day per field.
      const profile = await resolveFieldProfile(horus, ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title, {
        userRef: auth.userId,
        userToken: auth.jwt,
      });
      const result = await rankResources(deps, ctx, { ...args, technical: techJob(profile) });
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
        officialTraining: result.officialTraining,
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
        "One call for the whole learning side: what to work on (from the last interview's debrief when there is one), a week-by-week plan, ranked resources, the drill that's due, and what the next mock should target. Works for a brand-new learner with an empty database. Pass `explore` (\"cloud security\", \"moving into aged care\") for a plan built around something new; it's kept beside their main plan instead of replacing it.",
      inputSchema: S.learningPathwayInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const reasons: string[] = [];
      const field = fieldFor(ctx, args.field);
      const weeks = args.weeks ?? 4;
      const hoursPerWeek = args.hoursPerWeek ?? 5;
      // A plan to explore something is about that, not about the last mock's gaps.
      const explore = args.explore?.trim() || null;

      // What the last mock interview said to work on — this is the link that
      // keeps interviews and the pathway pointed at the same gaps.
      let focus: { skills: string[]; questionTypes?: string[]; why?: string } | null = null;
      if (!explore) {
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
      }

      const [research, profile, exploreProfile] = await Promise.all([
        researchSafely(deps.research, {
          field: explore ?? field,
          role: explore ? undefined : ctx.goal?.targetRole,
          intents: ["resource", "experience"],
          max: 4,
          // No knowledge index here: its documents are career reports and
          // application guides, which would end up as "resources" in the plan.
        }),
        // The real field only — never the "their field" placeholder.
        resolveFieldProfile(horus, args.field ?? ctx.goal?.targetField ?? ctx.targetField ?? ctx.job?.title, {
          userRef: auth.userId,
          userToken: auth.jwt,
        }),
        // What doing that work involves, when it's a kind of work the model
        // knows; otherwise the plan is built around the words themselves.
        explore ? resolveFieldProfile(horus, explore, { userRef: auth.userId, userToken: auth.jwt }) : null,
      ]);
      const exploreSkills = explore
        ? exploreProfile?.source === "model" && exploreProfile.keySkills.length > 0
          ? exploreProfile.keySkills
          : [explore]
        : undefined;

      const derived = deriveSkillTargets({
        ctx,
        skills: args.skills ?? exploreSkills ?? focus?.skills,
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
            goal: args.goal ?? (explore ? `Explore ${explore}` : ctx.goal?.targetRole),
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
          goal: args.goal ?? (explore ? `Explore ${explore}` : ctx.goal?.targetRole),
          field: explore ?? field,
          maxResults: 6,
          technical: techJob(exploreProfile?.source === "model" ? exploreProfile : profile),
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
        /** What this plan explores, when it isn't their usual plan for the job. */
        explore,
        focus: {
          skills: derived.targets.map((t) => t.skill),
          source: explore && !args.skills ? "explore" : derived.source,
          why: explore
            ? `You asked to explore ${explore}: these are the skills that work leans on most.`
            : (focus?.why ?? derived.note ?? "Your lowest-proficiency tested skills."),
          fromLastInterview: focus !== null,
        },
        targets: derived.targets,
        plan: planRes.data,
        resources: resourceResult.resources,
        unsourcedResources: resourceResult.unsourced,
        officialTraining: resourceResult.officialTraining,
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

      // Rebuilding a plan replaces it; a plan to explore something is filed
      // under that as well, so it sits beside their main plan for the job.
      const recommendationId = await saveResult(auth.db, auth.userId, {
        type: "pathway",
        title: explore
          ? `Explore: ${explore}`
          : `Learning pathway: ${derived.targets.map((t) => t.skill).slice(0, 3).join(", ")}`,
        description: `${weeks}w · ${hoursPerWeek} h/week · ${field}`,
        subject: explore ? `${args.field ?? field} · explore: ${explore}` : (args.field ?? field),
        payload: { pathway },
      });

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
