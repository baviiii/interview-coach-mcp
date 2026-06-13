import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { GroundingPort } from "../adapters/grounding/index.js";
import type { ModelProvider } from "../adapters/horus/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { persistSkillSignals, touchPracticePatterns } from "../context/persist.js";
import { focusSkill, nextDifficulty, shouldOfferHint } from "../domain/adaptive.js";
import {
  evaluateAnswerPrompt,
  finalEvaluationPrompt,
  generateQuestionsPrompt,
  hintPrompt,
} from "../domain/prompts.js";
import * as S from "../schemas.js";
import type { AuthContext } from "../server/auth.js";
import { clampScore, num, ok } from "./_util.js";

export interface ToolDeps {
  auth: AuthContext;
  /** The model seam — Horus by default; swap any ModelProvider for turnkey. */
  horus: ModelProvider;
  grounding: GroundingPort;
}

export function registerInterviewTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus, grounding } = deps;

  // ── build_interview_plan ────────────────────────────────────────────────
  server.registerTool(
    "build_interview_plan",
    {
      title: "Build a tailored interview plan",
      description:
        "Given a saved job, a pasted JD, or a role, returns a weighted interview loop (rounds, focus areas, time budget, prep checklist) personalized to the learner's weak skills.",
      inputSchema: S.buildPlanInput,
    },
    async (args) => {
      const src = args.source;
      const field = src.field ?? "Software Engineering";
      const seniority = src.seniority;
      const jobId = src.type === "saved_job" ? src.jobId : undefined;
      const jd = src.type === "paste" ? src.jobDescription : undefined;

      const ctx = await assembleLearnerContext(auth.db, auth.userId, { jobId, field, seniority });

      const system = `You are a former FAANG hiring manager designing a focused interview-prep plan.
Return ONLY JSON:
{ "targetRole": string, "company": string,
  "rounds": [{ "name": string, "minutes": number, "weight": number, "focusAreas": string[], "whyWeighted": string }],
  "prepChecklist": string[], "predictedHardestRound": string }`;

      const user = `Build a plan.
FIELD: ${field}
SENIORITY: ${seniority ?? "Mid-Level"}
TIME BUDGET: ${args.timeBudgetMinutes ?? 45} minutes
REQUESTED ROUNDS: ${(args.rounds ?? []).join(", ") || "you decide"}
${jd ? `JOB DESCRIPTION:\n${jd}\n` : ""}${ctx.job ? `TARGET JOB: ${ctx.job.title} @ ${ctx.job.company}\nKNOWN GAPS: ${(ctx.job.gaps ?? []).join(", ") || "n/a"}\n` : ""}WEAK SKILLS: ${ctx.weakSkills.map((s) => `${s.name} (${s.proficiency})`).join(", ") || "unknown"}
Weight rounds toward the intersection of the role's demands and the candidate's weak skills.`;

      const res = await horus.infer({
        task: "interview.build_plan",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      let recommendationId: string | null = null;
      try {
        const plan = res.data as { targetRole?: string };
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "practice_area",
            title: `Interview plan: ${plan.targetRole ?? field}`,
            description: "AI-generated interview prep plan",
            ai_reasoning: JSON.stringify(res.data).slice(0, 4000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort persistence */
      }

      return ok({ plan: res.data, recommendationId, _meta: { model: res.model, cached: res.cached } });
    },
  );

  // ── generate_contextual_questions ───────────────────────────────────────
  server.registerTool(
    "generate_contextual_questions",
    {
      title: "Generate contextual interview questions",
      description:
        "Weakness-focused, JD-aligned, seniority-calibrated question set. Biases coverage toward the learner's lowest-proficiency skills.",
      inputSchema: S.generateQuestionsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        jobId: args.jobId,
        field: args.field,
        seniority: args.seniority,
      });
      const { system, user } = generateQuestionsPrompt({
        field: args.field,
        seniority: args.seniority,
        jobDescription: args.jobDescription,
        focusAreas: args.focusAreas,
        count: args.count,
        ctx,
      });
      const res = await horus.infer({
        task: "interview.generate_questions",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });
      return ok({ ...(res.data as object), _meta: { model: res.model } });
    },
  );

  // ── start_interview_session ─────────────────────────────────────────────
  server.registerTool(
    "start_interview_session",
    {
      title: "Start a mock interview session",
      description: "Opens a session row and returns the first batch of questions.",
      inputSchema: S.startSessionInput,
    },
    async (args) => {
      let sessionId: string | null = null;
      try {
        // interview_sessions.field is NOT NULL in CareerCraft's schema.
        const { data } = await auth.db
          .from("interview_sessions")
          .insert({
            user_id: auth.userId,
            field: args.field,
            seniority: args.seniority ?? null,
            status: "in_progress",
          })
          .select("id")
          .single();
        sessionId = data?.id ?? null;
      } catch {
        /* base interview_sessions columns vary — best-effort; flow continues */
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        jobId: args.jobId,
        field: args.field,
        seniority: args.seniority,
      });
      const { system, user } = generateQuestionsPrompt({
        field: args.field,
        seniority: args.seniority,
        count: args.questionCount ?? 6,
        ctx,
      });
      const res = await horus.infer({
        task: "interview.generate_questions",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });
      const data = res.data as { questions?: unknown; analysis?: unknown };

      if (sessionId && Array.isArray(data.questions)) {
        try {
          await auth.db
            .from("interview_sessions")
            .update({ questions: data.questions, question_count: data.questions.length })
            .eq("id", sessionId);
        } catch {
          /* best-effort */
        }
      }

      return ok({
        sessionId,
        analysis: data.analysis,
        questions: data.questions,
        _meta: { model: res.model, persisted: sessionId !== null },
      });
    },
  );

  // ── submit_answer ───────────────────────────────────────────────────────
  server.registerTool(
    "submit_answer",
    {
      title: "Evaluate an interview answer",
      description:
        "Full rubric evaluation (content/communication/behavioral/strategic) + coaching + improved answer. Persists the answer and skill signal.",
      inputSchema: S.submitAnswerInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        field: args.field,
        seniority: args.seniority,
      });
      const { system, user } = evaluateAnswerPrompt({
        field: args.field,
        seniority: args.seniority,
        question: args.questionText,
        questionType: args.questionType,
        answer: args.answerText,
        expectedTopics: args.expectedTopics,
        ctx,
      });
      const res = await horus.infer<{ score?: number }>({
        task: "interview.evaluate_answer",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      let persisted = false;
      try {
        await auth.db.from("interview_answers").insert({
          session_id: args.sessionId,
          user_id: auth.userId,
          question_id: args.questionId ?? null,
          question_text: args.questionText,
          question_type: args.questionType ?? null,
          answer_text: args.answerText,
          overall_score: num(res.data.score),
          time_taken_seconds: args.timeTakenSeconds ?? null,
        });
        persisted = true;
      } catch {
        /* best-effort */
      }

      // Flywheel: demonstrated skill levels from this answer update the matrix,
      // which biases the next questions, drills, plans and recommendations.
      try {
        const assessed = (res.data as {
          skillsAssessed?: Array<{ skill?: string; proficiencyDemonstrated?: number }>;
        }).skillsAssessed;
        if (Array.isArray(assessed)) {
          await persistSkillSignals(
            auth.db,
            auth.userId,
            assessed
              .filter((a) => a.skill && typeof a.proficiencyDemonstrated === "number")
              .slice(0, 4)
              .map((a) => ({ name: a.skill!, demonstrated: a.proficiencyDemonstrated! })),
          );
        }
        await touchPracticePatterns(auth.db, auth.userId, { questionsDelta: 1 });
      } catch {
        /* best-effort */
      }

      // Ground the top coaching tip in a real source (proof-backed coaching).
      let proof = null;
      try {
        const tips = (res.data as { coachingTips?: Array<{ tip?: string }> }).coachingTips;
        const top = Array.isArray(tips) ? tips[0]?.tip : undefined;
        if (top) proof = await grounding.findEvidence({ claim: top, skill: args.field });
      } catch {
        /* grounding best-effort */
      }
      return ok({ evaluation: res.data, proof, _meta: { model: res.model, persisted } });
    },
  );

  // ── next_question (adaptive) ────────────────────────────────────────────
  server.registerTool(
    "next_question",
    {
      title: "Get the adaptive next question",
      description:
        "Branches difficulty off running performance and probes the learner's weakest skill — the 'real interview' feel.",
      inputSchema: S.nextQuestionInput,
    },
    async (args) => {
      let scores: number[] = [];
      try {
        const { data } = await auth.db
          .from("interview_answers")
          .select("overall_score")
          .eq("session_id", args.sessionId)
          .order("answered_at", { ascending: true });
        scores = (data ?? [])
          .map((r: { overall_score: unknown }) => Number(r.overall_score))
          .filter((n) => Number.isFinite(n));
      } catch {
        /* best-effort */
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        field: args.field,
        seniority: args.seniority,
      });
      const difficulty = nextDifficulty(scores);
      const skill = focusSkill(ctx);

      const system = `Return ONLY JSON for ONE next interview question:
{ "id": number, "question": string, "type": string, "difficulty": string, "category": string, "skillsTested": string[], "expectedTopics": string[] }
The "difficulty" MUST be "${difficulty}".`;
      const user = `FIELD: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
${skill ? `Probe this weak skill: ${skill}.` : ""}
Do not repeat themes already covered in this session.`;

      const res = await horus.infer({
        task: "interview.next_question",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
      });
      return ok({ question: res.data, difficulty, focusSkill: skill, _meta: { model: res.model } });
    },
  );

  // ── finish_interview ────────────────────────────────────────────────────
  server.registerTool(
    "finish_interview",
    {
      title: "Finish session and get final evaluation",
      description:
        "Grade, readiness, competency matrix, and improvement plan over the whole session. Persists score history and closes the session.",
      inputSchema: S.finishInput,
    },
    async (args) => {
      let transcript: Array<{ question: string; type?: string; answer: string; score?: number }> = [];
      try {
        const { data } = await auth.db
          .from("interview_answers")
          .select("question_text, question_type, answer_text, overall_score")
          .eq("session_id", args.sessionId)
          .order("answered_at", { ascending: true });
        transcript = (data ?? []).map((r: any) => ({
          question: r.question_text,
          type: r.question_type ?? undefined,
          answer: r.answer_text,
          score: num(r.overall_score) ?? undefined,
        }));
      } catch {
        /* best-effort */
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        field: args.field,
        seniority: args.seniority,
      });
      const { system, user } = finalEvaluationPrompt({
        field: args.field,
        seniority: args.seniority,
        transcript,
        ctx,
      });
      const res = await horus.infer<{ overallScore?: number }>({
        task: "interview.final_evaluation",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      try {
        await auth.db.from("score_history").insert({
          user_id: auth.userId,
          session_id: args.sessionId,
          overall_score: clampScore(res.data.overallScore) ?? 0,
        });
      } catch {
        /* best-effort */
      }
      try {
        await auth.db
          .from("interview_sessions")
          .update({
            completed_at: new Date().toISOString(),
            status: "completed",
            avg_score: clampScore(res.data.overallScore),
            ai_insights: res.data,
          })
          .eq("id", args.sessionId);
      } catch {
        /* best-effort */
      }
      try {
        await touchPracticePatterns(auth.db, auth.userId, { sessionsDelta: 1 });
      } catch {
        /* best-effort */
      }

      return ok({ evaluation: res.data, _meta: { model: res.model } });
    },
  );

  // ── get_interview_hint ──────────────────────────────────────────────────
  server.registerTool(
    "get_interview_hint",
    {
      title: "Get a mid-question hint",
      description:
        "One calibrated hint while the learner is stuck on a question — gentle nudge if they're performing well this session, structural help if they're struggling. Never reveals the answer.",
      inputSchema: S.interviewHintInput,
    },
    async (args) => {
      let scores: number[] = [];
      if (args.sessionId) {
        try {
          const { data } = await auth.db
            .from("interview_answers")
            .select("overall_score")
            .eq("session_id", args.sessionId)
            .order("answered_at", { ascending: true });
          scores = (data ?? [])
            .map((r: { overall_score: unknown }) => Number(r.overall_score))
            .filter((n) => Number.isFinite(n));
        } catch {
          /* best-effort */
        }
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const struggling = shouldOfferHint(scores);
      const { system, user } = hintPrompt({
        question: args.questionText,
        currentThinking: args.currentThinking,
        struggling,
        ctx,
      });
      const res = await horus.infer({
        task: "interview.hint",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
      });

      return ok({ ...(res.data as object), struggleDetected: struggling, _meta: { model: res.model } });
    },
  );
}
