import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { personaSynthesisPrompt } from "../domain/prompts.js";
import * as S from "../schemas.js";
import { certFactsBlock } from "./career.js";
import { ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * profile.* — the personalization layer made visible and steerable.
 * get_career_profile shows everything the coach knows (deterministic, no LLM);
 * refresh_persona re-synthesizes profiles.ai_persona from all current signals
 * so personalization deepens as the learner practices, certifies and applies.
 */
export function registerProfileTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus } = deps;

  // ── get_career_profile ──────────────────────────────────────────────────
  server.registerTool(
    "get_career_profile",
    {
      title: "Get the full career profile",
      description:
        "Everything the coach currently knows about this learner — goal, skill matrix, certifications (with expiry status), readiness, practice patterns, job pipeline, persona — plus which signals are still missing. Deterministic and instant; ideal grounding for any conversation.",
      inputSchema: {},
    },
    async () => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});

      const recent = ctx.recentOverallScores;
      const avgScore = recent.length ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10 : null;
      const readiness =
        avgScore === null
          ? "unknown — no scored sessions yet"
          : avgScore >= 80
            ? "interview-ready"
            : avgScore >= 65
              ? "almost ready"
              : avgScore >= 50
                ? "developing"
                : "needs foundational work";

      const missingSignals = [
        !ctx.goal?.targetField && !ctx.goal?.targetRole ? "career goal (set_career_goal)" : null,
        ctx.skills.length === 0 ? "skill matrix (run an interview session or drills)" : null,
        (ctx.certifications ?? []).length === 0 ? "certifications (log_certification)" : null,
        !ctx.resumeSummary ? "resume (upload in CareerCraft)" : null,
        !ctx.persona ? "coach persona (refresh_persona)" : null,
      ].filter(Boolean);

      return ok({
        userId: ctx.userId,
        goal: ctx.goal ?? null,
        readiness: { level: readiness, averageRecentScore: avgScore, recentScores: recent },
        skills: {
          tracked: ctx.skills.length,
          weakest: ctx.weakSkills.map((s) => ({ name: s.name, proficiency: s.proficiency, trend: s.trend })),
          strongest: ctx.strongSkills.map((s) => ({ name: s.name, proficiency: s.proficiency, trend: s.trend })),
        },
        certifications: (ctx.certifications ?? []).map((c) => ({
          name: c.name,
          issuer: c.issuer ?? null,
          status: c.status,
          expiryDate: c.expiryDate ?? null,
          recognized: Boolean(c.catalogId),
          skillsVouchedFor: c.skills ?? [],
        })),
        practice: ctx.patterns ?? null,
        jobPipeline: ctx.applications ?? null,
        milestonesAchieved: ctx.milestonesAchieved ?? 0,
        resumeOnFile: Boolean(ctx.resumeSummary),
        persona: ctx.persona ?? null,
        missingSignals,
      });
    },
  );

  // ── refresh_persona ─────────────────────────────────────────────────────
  server.registerTool(
    "refresh_persona",
    {
      title: "Re-synthesize the coach persona",
      description:
        "Folds every current signal (skills, certifications, scores, resume, pipeline, onboarding analysis) into an updated coaching persona and saves it to the profile — the memory that makes every future answer more personal. Run after milestones: a finished session streak, a new cert, a goal change.",
      inputSchema: S.refreshPersonaInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});

      let onboarding: unknown = undefined;
      try {
        const { data } = await auth.db
          .from("onboarding_runs")
          .select("ai_analysis")
          .eq("user_id", auth.userId)
          .eq("status", "completed")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        onboarding = data?.ai_analysis ?? undefined;
      } catch {
        /* best-effort */
      }

      const { system, user } = personaSynthesisPrompt({ ctx, onboarding, certFacts: certFactsBlock(ctx) });
      const res = await horus.infer<{ persona?: Record<string, unknown>; confidence?: number; basedOn?: string[] }>({
        task: "profile.synthesize_persona",
        system,
        messages: [
          {
            role: "user",
            content: args.focus ? `${user}\n\nSPECIAL FOCUS FOR THIS REFRESH: ${args.focus}` : user,
          },
        ],
        model: "deep",
        userRef: auth.userId,
        userToken: auth.jwt,
      });

      let persisted = false;
      if (res.data.persona && typeof res.data.persona === "object") {
        try {
          const { error } = await auth.db
            .from("profiles")
            .update({
              ai_persona: {
                ...res.data.persona,
                _meta: {
                  synthesizedAt: new Date().toISOString(),
                  confidence: res.data.confidence ?? null,
                  basedOn: res.data.basedOn ?? [],
                },
              },
            })
            .eq("id", auth.userId);
          persisted = !error;
        } catch {
          /* best-effort */
        }
      }

      return ok({
        persona: res.data.persona ?? null,
        confidence: res.data.confidence ?? null,
        basedOn: res.data.basedOn ?? [],
        persisted,
        _meta: { model: res.model },
      });
    },
  );
}
