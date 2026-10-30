import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { newestSessionId, saveResult } from "../context/saved-results.js";
import { parseRoundType, ROUND_LABELS, ROUND_TYPES } from "../domain/interview-loop.js";
import type { AuthContext } from "../server/auth.js";
import * as S from "../schemas.js";
import { num, ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

const MIX_DAYS = 28;

/**
 * The last four weeks of practice, by round type. Without it the weekly note
 * can't say the most useful thing it has to say — "you've done six behavioural
 * rounds and never a phone screen". Empty when there's nothing (or no access).
 */
async function practiceMix(db: AuthContext["db"], userId: string): Promise<string> {
  try {
    const since = new Date(Date.now() - MIX_DAYS * 86_400_000).toISOString();
    const { data, error } = await db
      .from("interview_sessions")
      .select("round_type, status, avg_score, created_at")
      .eq("user_id", userId)
      .gte("created_at", since);
    if (error || !data?.length) return "";

    const lines = ROUND_TYPES.map((type) => {
      // Sessions from before round types existed were full loops.
      const rows = data.filter((r: { round_type?: unknown }) => parseRoundType(r.round_type) === type);
      if (!rows.length) return `- ${ROUND_LABELS[type]}: none`;
      const finished = rows.filter((r: { status?: unknown }) => r.status === "completed");
      const scores = finished
        .map((r: { avg_score?: unknown }) => num(r.avg_score))
        .filter((n): n is number => n !== null && n > 0);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      return `- ${ROUND_LABELS[type]}: ${rows.length} started, ${finished.length} finished${avg !== null ? `, average ${avg}/100` : ""}`;
    });
    return `PRACTICE MIX, LAST ${MIX_DAYS} DAYS (counted from their sessions):\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/**
 * analytics.* — derived insight over the learner's real signals (skill trends,
 * recent scores, behavioral patterns). Everything is conditioned on the
 * RLS-scoped context from `assembleLearnerContext`; the model only summarizes
 * what the data already says. Ported from the careercraft `interview-ai`
 * analyze_patterns / weekly_insight actions so analytics lives in one brain.
 */
export function registerAnalyticsTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus } = deps;

  // ── analyze_patterns ─────────────────────────────────────────────────────
  server.registerTool(
    "analyze_patterns",
    {
      title: "Analyze interview performance patterns",
      description:
        "Detects recurring strengths/weaknesses, trends and correlations across the learner's skill history and recent scores, then returns targeted recommendations.",
      inputSchema: S.analyzePatternsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        field: args.field,
        seniority: args.seniority,
      });

      const system = `You are an AI career coach specializing in identifying patterns and providing personalized improvement strategies. Analyze the learner's interview performance data to find actionable insights.

Your analysis should:
1. Identify recurring strengths and weaknesses
2. Detect improvement or decline trends
3. Find correlations between different skills
4. Suggest targeted practice areas
5. Predict areas of future difficulty

Return ONLY JSON with this structure:
{
  "patternSummary": "Overview of detected patterns",
  "strengths": { "consistent": string[], "improving": string[], "evidence": "Data points supporting this" },
  "weaknesses": { "persistent": string[], "declining": string[], "evidence": "Data points supporting this" },
  "correlations": [{ "observation": string, "implication": string }],
  "riskAreas": string[],
  "recommendations": [{ "priority": number, "skill": string, "reason": string, "suggestedPractice": string, "expectedTimeToImprove": string }],
  "progressProjection": { "currentTrajectory": string, "optimisticScenario": string, "pessimisticScenario": string }
}`;

      const skillLines = ctx.skills
        .map((s) => `- ${s.name} (${s.category ?? "general"}): ${s.proficiency}/100, trend ${s.trend}, tested ${s.timesTested ?? 0}x`)
        .join("\n");
      const user = `Analyze interview performance patterns for this learner.

FIELD: ${args.field ?? ctx.targetField ?? "General"}
SENIORITY: ${args.seniority ?? ctx.targetSeniority ?? "Mid-Level"}

SKILL SNAPSHOT (sorted weakest-first):
${skillLines || "- No skill data yet"}

RECENT OVERALL SCORES (oldest to newest): ${ctx.recentOverallScores.join(", ") || "none"}

BEHAVIORAL PATTERNS:
- Overall trend: ${ctx.patterns?.overallTrend ?? "unknown"}
- Strongest question type: ${ctx.patterns?.strongestQuestionType ?? "unknown"}
- Weakest question type: ${ctx.patterns?.weakestQuestionType ?? "unknown"}
- Current streak (days): ${ctx.patterns?.currentStreakDays ?? 0}
- Total sessions: ${ctx.patterns?.totalSessions ?? 0}

Identify patterns and provide actionable recommendations grounded strictly in the data above.`;

      const res = await horus.infer({
        task: "analytics.analyze_patterns",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
        userToken: auth.jwt,
      });
      return ok({ ...(res.data as object), _meta: { model: res.model } });
    },
  );

  // ── weekly_insight ───────────────────────────────────────────────────────
  server.registerTool(
    "weekly_insight",
    {
      title: "Generate a weekly progress insight",
      description:
        "An encouraging, specific weekly summary built from the learner's recent scores, streak, and skill signals.",
      inputSchema: S.weeklyInsightInput,
    },
    async (args) => {
      const [ctx, mix] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, {
          field: args.field,
          seniority: args.seniority,
        }),
        practiceMix(auth.db, auth.userId),
      ]);

      // Plain on purpose. This note sits on the learner's own progress page;
      // a "catchy" headline and emoji read as filler there, and the learner
      // has said as much about the rest of the product.
      const system = `You are an interview coach writing a short weekly note on one learner's practice. Plain, specific and honest — like a good coach's message, not a newsletter. No exclamation marks, no emoji, no hype words.

Return ONLY JSON with this structure:
{
  "headline": "one plain sentence: the most important thing about their practice right now",
  "summary": "2-3 sentences: what the numbers below show, and what to do about it",
  "highlights": [{ "type": "achievement|improvement|milestone", "title": string, "detail": string }],
  "progressMetrics": { "scoreChange": string, "interpretation": string },
  "focusAreas": [{ "skill": string, "currentLevel": string, "targetLevel": string, "suggestedActions": string[] }],
  "weeklyGoals": [{ "goal": "one concrete thing to do this week, e.g. a round type to practise and why", "reason": string, "howToAchieve": string }]
}`;

      const recent = ctx.recentOverallScores;
      const avg = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : 0;
      const user = `Generate a weekly insight summary grounded in this data.

FIELD: ${args.field ?? ctx.targetField ?? "General"}
SENIORITY: ${args.seniority ?? ctx.targetSeniority ?? "Mid-Level"}

RECENT OVERALL SCORES (oldest to newest): ${recent.join(", ") || "none"}
APPROX AVERAGE: ${avg}
CURRENT STREAK (days): ${ctx.patterns?.currentStreakDays ?? 0}
TOTAL SESSIONS: ${ctx.patterns?.totalSessions ?? 0}
TOP SKILLS: ${ctx.strongSkills.map((s) => s.name).join(", ") || "none yet"}
SKILLS NEEDING WORK: ${ctx.weakSkills.map((s) => s.name).join(", ") || "none yet"}
${mix ? `\n${mix}\nRound types: Phone screen = a recruiter's first call; Behavioural = past-situation (STAR) questions; Technical = the work itself; Full interview = a mixed final round. If they've skipped a type that their next real interview will include, say so and make practising it one of the weekly goals.\n` : ""}
Do not invent metrics that aren't supported by the data above.`;

      const [res, basedOn] = await Promise.all([
        horus.infer({
          task: "analytics.weekly_insight",
          system,
          messages: [{ role: "user", content: user }],
          model: "fast",
          userRef: auth.userId,
          userToken: auth.jwt,
        }),
        newestSessionId(auth.db, auth.userId),
      ]);
      // Saved with the session it was written after: the site shows this note
      // until a newer session exists, instead of asking again on every visit.
      const insight = { ...(res.data as object), basedOn };
      await saveResult(auth.db, auth.userId, {
        type: "weekly_insight",
        title: "Weekly practice note",
        subject: args.field ?? ctx.targetField,
        payload: insight,
      });
      return ok({ ...insight, _meta: { model: res.model } });
    },
  );
}
