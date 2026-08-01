import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { GroundingPort } from "../adapters/grounding/index.js";
import type { ModelProvider } from "../adapters/horus/index.js";
import type { ResearchPort } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { persistSkillSignals, touchPracticePatterns } from "../context/persist.js";
import { focusSkill, nextDifficulty, shouldOfferHint } from "../domain/adaptive.js";
import { interviewBlueprint, stageCoverage, type QuestionSlot } from "../domain/interview-loop.js";
import {
  evaluateAnswerPrompt,
  finalEvaluationPrompt,
  generateQuestionsPrompt,
  hintPrompt,
  nextQuestionPrompt,
  realWorldBlock,
} from "../domain/prompts.js";
import * as S from "../schemas.js";
import type { AuthContext } from "../server/auth.js";
import { clampScore, num, ok, researchMeta, researchSafely } from "./_util.js";

export interface ToolDeps {
  auth: AuthContext;
  /** The model seam — Horus by default; swap any ModelProvider for turnkey. */
  horus: ModelProvider;
  grounding: GroundingPort;
  /** Live "research before generate" — real, cited field material (free sources). */
  research: ResearchPort;
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
      const seniority = src.seniority;
      const jobId = src.type === "saved_job" ? src.jobId : undefined;
      const jd = src.type === "paste" ? src.jobDescription : undefined;

      const ctx = await assembleLearnerContext(auth.db, auth.userId, { jobId, field: src.field, seniority });
      // Never assume software: fall back to what the learner actually told us.
      const field = src.field ?? ctx.goal?.targetField ?? ctx.job?.title ?? "Software Engineering";
      const research = await researchSafely(deps.research, {
        field,
        role: ctx.goal?.targetRole,
        seniority,
        jobDescription: jd,
        intents: ["question", "experience", "credential"],
        max: 4,
      });

      const system = `You are a seasoned hiring manager for ${field} roles designing a focused interview-prep plan that mirrors how THIS field actually interviews (rounds, formats, what each stage screens for).
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
${realWorldBlock(research)}
Weight rounds toward the intersection of the role's real interview structure (above) and the candidate's weak skills.`;

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

      return ok({
        plan: res.data,
        recommendationId,
        _meta: { model: res.model, cached: res.cached, research: researchMeta(research) },
      });
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
      // Research what THIS field actually gets asked / struggles with, first.
      const research = await researchSafely(deps.research, {
        field: args.field,
        role: ctx.goal?.targetRole,
        seniority: args.seniority,
        jobDescription: args.jobDescription,
        intents: ["question", "experience"],
        max: 4,
      });
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: args.count,
        focusAreas: args.focusAreas,
        ctx,
      });
      const { system, user } = generateQuestionsPrompt({
        blueprint,
        jobDescription: args.jobDescription,
        focusAreas: args.focusAreas,
        ctx,
        research,
      });
      const res = await horus.infer({
        task: "interview.generate_questions",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        // Higher temperature: the complaint is sameness, and the blueprint —
        // not the sampler — is what keeps the structure honest.
        temperature: 0.9,
        userRef: auth.userId,
      });
      return ok({
        ...(res.data as object),
        blueprint: blueprint.slots,
        _meta: { model: res.model, behavioralCount: blueprint.behavioralCount, research: researchMeta(research) },
      });
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
      const research = await researchSafely(deps.research, {
        field: args.field,
        role: ctx.goal?.targetRole,
        seniority: args.seniority,
        jobDescription: args.jobDescription,
        intents: ["question", "experience"],
        max: 4,
      });
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: args.questionCount ?? 6,
        focusAreas: args.focusAreas,
        ctx,
      });
      const { system, user } = generateQuestionsPrompt({
        blueprint,
        jobDescription: args.jobDescription,
        focusAreas: args.focusAreas,
        ctx,
        research,
      });
      const res = await horus.infer({
        task: "interview.generate_questions",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        temperature: 0.9,
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
        blueprint: blueprint.slots,
        _meta: {
          model: res.model,
          persisted: sessionId !== null,
          behavioralCount: blueprint.behavioralCount,
          research: researchMeta(research),
        },
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
      const [ctx, stored, transcript] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, { field: args.field, seniority: args.seniority }),
        readSessionQuestions(auth.db, args.sessionId),
        readTranscript(auth.db, args.sessionId),
      ]);

      // The frontend doesn't always pass type/expectedTopics. Recover them from
      // the question we generated for this session rather than evaluating blind.
      const planned = matchStoredQuestion(stored, args.questionId, args.questionText);
      const questionType = args.questionType ?? planned?.type ?? planned?.stage;
      const expectedTopics = args.expectedTopics ?? planned?.expectedTopics;

      const { system, user } = evaluateAnswerPrompt({
        field: args.field,
        seniority: args.seniority,
        question: args.questionText,
        questionType,
        answer: args.answerText,
        expectedTopics,
        transcript: transcript.map((t) => ({ question: t.question, answer: t.answer, score: t.score })),
        ctx,
      });
      const res = await horus.infer<{ score?: number }>({
        task: "interview.evaluate_answer",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        // Scoring must be stable across runs — variety belongs in generation.
        temperature: 0.2,
        userRef: auth.userId,
      });

      let persisted = false;
      try {
        await auth.db.from("interview_answers").insert({
          session_id: args.sessionId,
          user_id: auth.userId,
          question_id: args.questionId ?? null,
          question_text: args.questionText,
          question_type: questionType ?? null,
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
      const [ctx, transcript, stored] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, { field: args.field, seniority: args.seniority }),
        readTranscript(auth.db, args.sessionId),
        readSessionQuestions(auth.db, args.sessionId),
      ]);

      const scores = transcript.map((t) => t.score).filter((n): n is number => n != null);
      const covered = transcript.map((t) => t.question).slice(-10);
      const difficulty = nextDifficulty(scores);
      const skill = focusSkill(ctx);

      // Keep following the loop's shape: the slot we'd be on now decides the
      // stage and type, so the adaptive path can't quietly drop the behavioural
      // half of the interview.
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        // Size the loop to the session actually in progress, so a long session
        // doesn't get pinned to the last slot once it runs past the default.
        questionCount: Math.max(stored.length, transcript.length + 1, 6),
        focusAreas: args.focusAreas,
        ctx,
      });
      const slot: QuestionSlot | undefined =
        blueprint.slots[Math.min(transcript.length, blueprint.slots.length - 1)];

      const research = await researchSafely(deps.research, {
        field: args.field,
        role: ctx.goal?.targetRole,
        seniority: args.seniority,
        intents: ["question", "experience"],
        max: 3,
      });

      const last = transcript[transcript.length - 1];
      const { system, user } = nextQuestionPrompt({
        field: args.field,
        seniority: args.seniority,
        difficulty,
        slot: slot ? { stage: slot.stage, type: slot.type, intent: slot.intent } : undefined,
        focusSkill: slot?.targetSkill ?? skill,
        focusAreas: args.focusAreas,
        lastExchange: last ? { question: last.question, answer: last.answer, score: last.score } : undefined,
        covered,
        ctx,
        research,
      });

      const res = await horus.infer({
        task: "interview.next_question",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        temperature: 0.9,
        userRef: auth.userId,
      });

      // Append to the session so finish_interview sees the full planned loop,
      // not just the questions that happened to be answered.
      await appendSessionQuestion(auth.db, args.sessionId, res.data);

      return ok({
        question: res.data,
        difficulty,
        stage: slot?.stage,
        focusSkill: slot?.targetSkill ?? skill,
        _meta: { model: res.model, research: researchMeta(research) },
      });
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
      const [ctx, transcript] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, { field: args.field, seniority: args.seniority }),
        readTranscript(auth.db, args.sessionId),
      ]);

      const research = await researchSafely(deps.research, {
        field: args.field,
        role: ctx.goal?.targetRole,
        seniority: args.seniority,
        intents: ["experience", "question"],
        max: 3,
      });
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: Math.max(transcript.length, 6),
        ctx,
      });

      const { system, user } = finalEvaluationPrompt({
        field: args.field,
        seniority: args.seniority,
        transcript,
        coverage: stageCoverage(blueprint, transcript),
        ctx,
        research,
      });
      const res = await horus.infer<{ overallScore?: number }>({
        task: "interview.final_evaluation",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        temperature: 0.2,
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

      // Hand the debrief's focus to the learning side: get_learning_pathway
      // reads this back so the plan targets what the mock just exposed.
      let recommendationId: string | null = null;
      try {
        const focus = (res.data as { nextSessionFocus?: { skills?: string[]; why?: string } }).nextSessionFocus;
        if (focus?.skills?.length) {
          const { data } = await auth.db
            .from("ai_recommendations")
            .insert({
              user_id: auth.userId,
              recommendation_type: "practice_area",
              title: `Focus after ${args.field} mock: ${focus.skills.slice(0, 3).join(", ")}`,
              description: focus.why ?? null,
              ai_reasoning: JSON.stringify(focus).slice(0, 4000),
              status: "active",
            })
            .select("id")
            .single();
          recommendationId = data?.id ?? null;
        }
      } catch {
        /* best-effort */
      }

      return ok({
        evaluation: res.data,
        recommendationId,
        _meta: { model: res.model, research: researchMeta(research) },
      });
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

/* ── session helpers (all best-effort: a divergent schema must never break a
      live interview) ──────────────────────────────────────────────────────── */

interface StoredQuestion {
  id?: string | number;
  question?: string;
  stage?: string;
  type?: string;
  expectedTopics?: string[];
}

/** The questions we generated for this session, as stored on the session row. */
async function readSessionQuestions(db: AuthContext["db"], sessionId: string): Promise<StoredQuestion[]> {
  try {
    const { data } = await db.from("interview_sessions").select("questions").eq("id", sessionId).maybeSingle();
    const qs = (data as { questions?: unknown } | null)?.questions;
    return Array.isArray(qs) ? (qs as StoredQuestion[]) : [];
  } catch {
    return [];
  }
}

/** Match an answered question back to the one we planned, by id then by text. */
function matchStoredQuestion(
  stored: StoredQuestion[],
  questionId: string | undefined,
  questionText: string,
): StoredQuestion | undefined {
  if (stored.length === 0) return undefined;
  if (questionId) {
    const byId = stored.find((q) => String(q.id) === String(questionId));
    if (byId) return byId;
  }
  const needle = questionText.replace(/\s+/g, " ").trim().toLowerCase();
  return stored.find((q) => (q.question ?? "").replace(/\s+/g, " ").trim().toLowerCase() === needle);
}

/** Append an adaptively-generated question to the session's question list. */
async function appendSessionQuestion(db: AuthContext["db"], sessionId: string, question: unknown): Promise<void> {
  if (!question || typeof question !== "object") return;
  try {
    const existing = await readSessionQuestions(db, sessionId);
    const next = [...existing, question as StoredQuestion];
    await db
      .from("interview_sessions")
      .update({ questions: next, question_count: next.length })
      .eq("id", sessionId);
  } catch {
    /* best-effort */
  }
}

/** The session so far, oldest first. */
async function readTranscript(
  db: AuthContext["db"],
  sessionId: string,
): Promise<Array<{ question: string; type?: string; answer: string; score?: number }>> {
  try {
    const { data } = await db
      .from("interview_answers")
      .select("question_text, question_type, answer_text, overall_score")
      .eq("session_id", sessionId)
      .order("answered_at", { ascending: true });
    return (data ?? []).map((r: any) => ({
      question: String(r.question_text ?? "").trim(),
      type: r.question_type ?? undefined,
      answer: String(r.answer_text ?? ""),
      score: num(r.overall_score) ?? undefined,
    }));
  } catch {
    return [];
  }
}
