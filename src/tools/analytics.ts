import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import * as S from "../schemas.js";
import { ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

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
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        field: args.field,
        seniority: args.seniority,
      });

      const system = `You are an encouraging AI career coach providing a weekly progress summary. Your tone should be motivating and positive, honest about areas for improvement, specific with actionable advice, celebratory of achievements, and forward-looking.

Return ONLY JSON with this structure:
{
  "headline": "Catchy, encouraging headline for the week",
  "summary": "2-3 sentence overview",
  "highlights": [{ "type": "achievement|improvement|milestone", "title": string, "detail": string, "emoji": string }],
  "progressMetrics": { "scoreChange": string, "interpretation": string },
  "focusAreas": [{ "skill": string, "currentLevel": string, "targetLevel": string, "suggestedActions": string[] }],
  "weeklyGoals": [{ "goal": string, "reason": string, "howToAchieve": string }],
  "motivationalMessage": "Personalized encouragement",
  "funFact": "An interesting interview or career fact"
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

Do not invent metrics that aren't supported by the data above.`;

      const res = await horus.infer({
        task: "analytics.weekly_insight",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
        userToken: auth.jwt,
      });
      return ok({ ...(res.data as object), _meta: { model: res.model } });
    },
  );
}
