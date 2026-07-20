import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { rankResourcesPrompt } from "../domain/prompts.js";
import * as S from "../schemas.js";
import { err, ok, researchMeta, researchSafely } from "./_util.js";
import type { ToolDeps } from "./interview.js";

interface Candidate {
  id: string;
  title: string;
  type: string;
  difficulty?: string;
  provider?: string;
}

export function registerLearningTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus } = deps;

  // ── rank_learning_resources ─────────────────────────────────────────────
  server.registerTool(
    "rank_learning_resources",
    {
      title: "Rank learning resources with reasons",
      description:
        "Ranks learning_resources for the learner's weak skills / stated goal, each with a 'whyRecommended' and priority.",
      inputSchema: S.rankResourcesInput,
    },
    async (args) => {
      let candidates: Candidate[] = [];
      try {
        let q = auth.db
          .from("learning_resources")
          .select("id, title, resource_type, difficulty, provider, skill_tags")
          .eq("is_active", true)
          .limit(args.maxResults ?? 8);
        if (args.skillIds?.length) q = q.overlaps("skill_tags", args.skillIds);
        const { data } = await q;
        candidates = (data ?? []).map((r: any) => ({
          id: r.id,
          title: r.title,
          type: r.resource_type,
          difficulty: r.difficulty ?? undefined,
          provider: r.provider ?? undefined,
        }));
      } catch {
        /* best-effort */
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const skills = args.skills ?? ctx.weakSkills.map((s) => s.name);

      // Community-recommended resources for the field (free research). Kept
      // separate from the ranked DB rows so id-based progress tracking is intact
      // — and so a field with an empty learning_resources table still gets help.
      const research = await researchSafely(deps.research, {
        field: skills[0] ?? args.goal ?? ctx.goal?.targetField ?? ctx.targetField ?? "their field",
        role: ctx.goal?.targetRole,
        intents: ["resource"],
        max: args.maxResults ?? 6,
      });
      const communityResources = research.resources.map((s) => ({
        title: s.text.length > 90 ? `${s.text.slice(0, 89)}…` : s.text,
        provider: s.sourceLabel,
        url: s.sourceUrl,
        stat: s.stat ?? null,
        why: "Community-recommended for this field.",
      }));

      let ranked: Array<{ id: string; priority: number; whyRecommended: string }> = [];
      if (candidates.length > 0) {
        const { system, user } = rankResourcesPrompt({ goal: args.goal, skills, candidates, ctx });
        const res = await horus.infer<{ ranked?: typeof ranked }>({
          task: "study.rank_resources",
          system,
          messages: [{ role: "user", content: user }],
          model: "fast",
          userRef: auth.userId,
        });
        ranked = res.data.ranked ?? [];
      }

      const byId = new Map(candidates.map((c) => [c.id, c]));
      const results =
        ranked.length > 0
          ? ranked
              .map((r) => {
                const c = byId.get(r.id);
                return c ? { ...c, priority: r.priority, whyRecommended: r.whyRecommended } : null;
              })
              .filter((x): x is Candidate & { priority: number; whyRecommended: string } => x !== null)
          : candidates.map((c, i) => ({
              ...c,
              priority: i + 1,
              whyRecommended: `Targets ${skills[0] ?? "your goal"}.`,
            }));

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "resource",
            title: `Resources for ${skills[0] ?? "your goal"}`,
            description: args.goal ?? null,
            ai_reasoning: JSON.stringify(results).slice(0, 4000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({ resources: results, communityResources, recommendationId, _meta: { research: researchMeta(research) } });
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
