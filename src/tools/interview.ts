import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { GroundingPort } from "../adapters/grounding/index.js";
import type { ModelProvider } from "../adapters/horus/index.js";
import type { ResearchPort } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { resolveFieldProfile } from "../context/field-profile.js";
import { persistSkillSignals, touchPracticePatterns } from "../context/persist.js";
import { focusSkill, nextDifficulty, shouldOfferHint } from "../domain/adaptive.js";
import { ownedJobId, saveAnswerDetail, saveStory, tagSession, type StoryOutcome } from "../context/interview-store.js";
import { competencyLabel, competencySet, isCompetencyKey } from "../domain/competencies.js";
import {
  alignToBlueprint,
  alignToSlot,
  interviewBlueprint,
  lengthCheck,
  readWordBand,
  slotDefaults,
  stageCoverage,
  type QuestionSlot,
  type RoundType,
} from "../domain/interview-loop.js";
import { buildScore, locateQuotes, ownershipCounts, rubricFor } from "../domain/scoring.js";
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
import { clampScore, groundingFits, num, ok, researchMeta, researchSafely } from "./_util.js";

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
      // Never assume a field: fall back to what the learner actually told us, and
      // with nothing at all, let the JD (or the model) define the role.
      const field =
        src.field ??
        ctx.goal?.targetField ??
        ctx.job?.title ??
        ctx.targetField ??
        (jd ? "the role in the job description" : "the candidate's target role");
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

        userToken: auth.jwt,
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
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: args.field,
          role: ctx.goal?.targetRole,
          seniority: args.seniority,
          jobDescription: args.jobDescription,
          intents: ["question", "experience"],
          max: 4,
        }),
        resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: args.count,
        focusAreas: args.focusAreas,
        ctx,
        profile,
        roundType: args.roundType,
        framework: args.framework,
        frameworkLevel: args.frameworkLevel,
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

        userToken: auth.jwt,
      });
      const data = res.data as { questions?: unknown };
      return ok({
        ...(res.data as object),
        questions: alignToBlueprint(data.questions, blueprint),
        roundType: blueprint.roundType,
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
      const roundType: RoundType = args.roundType ?? "full";
      // Realistic mode asks for one question now and the rest adaptively, but
      // that one must be slot 1 of the round actually planned (the pitch of a
      // phone screen, the warm-up of a full loop), not of a one-question loop.
      const generateNow = args.questionCount ?? 6;
      const planned = Math.max(args.plannedCount ?? generateNow, generateNow);

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
      if (sessionId) {
        await tagSession(auth.db, sessionId, {
          roundType,
          framework: args.framework,
          jobApplicationId: await ownedJobId(auth.db, auth.userId, args.jobId),
        });
      }

      // Practising a question again: ask exactly what they chose, no generation.
      if (args.fixedQuestions?.length) {
        const questions = args.fixedQuestions.map((q, i) => {
          const defaults = slotDefaults(q.stage, q.type);
          const competency = isCompetencyKey(q.competency) ? q.competency : undefined;
          return {
            id: i + 1,
            question: q.question,
            stage: defaults.stage,
            type: q.type ?? (defaults.stage === "domain" ? "technical" : "behavioral"),
            difficulty: q.difficulty ?? "medium",
            category: q.type ?? defaults.stage,
            expectedTopics: q.expectedTopics ?? [],
            timeAllocationMinutes: defaults.minutes,
            ...(defaults.targetWords ? { targetWords: defaults.targetWords } : {}),
            ...(competency ? { competency, competencyLabel: competencyLabel(competency, args.seniority) } : {}),
            whyThisQuestion: "You chose to practise this one again.",
            followUps: [],
            signalsSought: [],
          };
        });
        if (sessionId) {
          try {
            await auth.db.from("interview_sessions").update({ questions, question_count: questions.length }).eq("id", sessionId);
          } catch {
            /* best-effort */
          }
        }
        return ok({ sessionId, roundType, questions, blueprint: [], _meta: { persisted: sessionId !== null, fixed: true } });
      }

      const ctx = await assembleLearnerContext(auth.db, auth.userId, {
        jobId: args.jobId,
        field: args.field,
        seniority: args.seniority,
      });
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: args.field,
          role: ctx.goal?.targetRole,
          seniority: args.seniority,
          jobDescription: args.jobDescription,
          intents: ["question", "experience"],
          max: 4,
        }),
        resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);
      const fullPlan = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: planned,
        focusAreas: args.focusAreas,
        ctx,
        profile,
        roundType,
        framework: args.framework,
        frameworkLevel: args.frameworkLevel,
        firstCompetency: args.competency,
      });
      const blueprint = { ...fullPlan, slots: fullPlan.slots.slice(0, generateNow) };
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

        userToken: auth.jwt,
      });
      const data = res.data as { questions?: unknown; analysis?: unknown };
      const questions = alignToBlueprint(data.questions, blueprint);

      if (sessionId && questions.length) {
        try {
          await auth.db
            .from("interview_sessions")
            .update({ questions, question_count: questions.length })
            .eq("id", sessionId);
        } catch {
          /* best-effort */
        }
      }

      return ok({
        sessionId,
        roundType,
        analysis: data.analysis,
        questions,
        blueprint: fullPlan.slots,
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
      // The slot is the contract, so the stored type wins over whatever the
      // client echoes back; the client's value covers sessions stored before
      // questions were aligned to their slots.
      const questionType = planned?.type ?? args.questionType ?? planned?.stage;
      const expectedTopics = args.expectedTopics ?? planned?.expectedTopics;
      const roundType = args.roundType ?? inferRoundType(stored);
      const length = lengthCheck(args.answerText, readWordBand(planned?.targetWords));
      const rubric = rubricFor(questionType, { stage: planned?.stage, roundType });
      const ownership = rubric.star ? ownershipCounts(args.answerText) : null;
      // Story questions are filed under a competency: the one the slot named, or
      // (a warm-up, an older session) the one the evaluator picks from the set.
      const slotCompetency = rubric.star && isCompetencyKey(planned?.competency) ? planned!.competency! : null;
      const choices = rubric.star && !slotCompetency
        ? competencySet({ framework: args.framework, seniority: args.seniority }).map((c) => ({ key: c.key, label: c.label }))
        : undefined;
      const attempt = args.attempt ?? 1;

      const { system, user } = evaluateAnswerPrompt({
        field: args.field,
        seniority: args.seniority,
        question: args.questionText,
        questionType,
        stage: planned?.stage,
        answer: args.answerText,
        expectedTopics,
        // Earlier questions only: a retry's earlier attempt goes in as "previous".
        transcript: latestPerQuestion(transcript)
          .filter((t) => !sameQuestion(t.question, args.questionText))
          .map((t) => ({ question: t.question, answer: t.answer, score: t.score })),
        ctx,
        roundType,
        length,
        ownership,
        previous: args.previousAnswer ? { answer: args.previousAnswer, score: args.previousScore ?? null, attempt } : null,
        competency: slotCompetency ? { key: slotCompetency, label: competencyLabel(slotCompetency, args.seniority) } : null,
        competencyChoices: choices,
        framework: args.framework,
      });
      const res = await horus.infer<EvaluationData>({
        task: "interview.evaluate_answer",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        // Scoring must be stable across runs — variety belongs in generation.
        temperature: 0.2,
        userRef: auth.userId,

        userToken: auth.jwt,
      });

      // The model scored the dimensions; the overall score is ours to compute,
      // so the learner can see exactly how it was made.
      const scoring = buildScore(rubric, res.data.scoreBreakdown, res.data.cap, res.data.score);
      const highlights = rubric.star ? locateQuotes(args.answerText, res.data.starQuotes) : [];
      const evaluation = { ...res.data, score: scoring.final, modelScore: num(res.data.score) };
      const improvement =
        typeof args.previousScore === "number" ? { from: args.previousScore, to: scoring.final, attempt } : null;

      let persisted = false;
      let answerId: string | null = null;
      try {
        const { data: row, error } = await auth.db
          .from("interview_answers")
          .insert({
            session_id: args.sessionId,
            user_id: auth.userId,
            question_id: args.questionId ?? null,
            question_text: args.questionText,
            question_type: questionType ?? null,
            answer_text: args.answerText,
            overall_score: scoring.final,
            time_taken_seconds: args.timeTakenSeconds ?? null,
          })
          .select("id")
          .single();
        persisted = !error;
        answerId = (row as { id?: string } | null)?.id ?? null;
      } catch {
        /* best-effort */
      }
      if (answerId) {
        await saveAnswerDetail(auth.db, answerId, {
          evaluation: { ...evaluation, scoring, highlights, ownership, lengthCheck: length, competency: slotCompetency },
          attempt,
        });
      }

      // The story library: their best version of each competency's story.
      let story: StoryOutcome | null = null;
      const storyCompetency = slotCompetency ?? (isCompetencyKey(res.data.competency) ? res.data.competency : null);
      const storyTitle = typeof res.data.storyTitle === "string" ? res.data.storyTitle.trim().slice(0, 120) : "";
      if (rubric.star && storyCompetency && storyTitle && scoring.final > 0) {
        story = await saveStory(auth.db, auth.userId, {
          competency: storyCompetency,
          title: storyTitle,
          answer: args.answerText,
          score: scoring.final,
          star: res.data.starBreakdown ?? null,
          sessionId: args.sessionId,
          seniority: args.seniority,
        });
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
        // Only a tech-only source needs the job's profile, and only after the
        // marking is done: resolving it alongside the evaluation put a second
        // model call in flight at once, which is what CareerCraft's infer
        // function can't start workers for (503 BOOT_ERROR).
        const fits = async () =>
          !grounding.techOnly ||
          groundingFits(grounding, await resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt }));
        if (top && (await fits())) {
          proof = await grounding.findEvidence({ claim: top, skill: args.field });
        }
      } catch {
        /* grounding best-effort */
      }
      return ok({
        evaluation,
        scoring,
        highlights,
        ownership,
        lengthCheck: length,
        story,
        improvement,
        proof,
        _meta: { model: res.model, persisted },
      });
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

      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: args.field,
          role: ctx.goal?.targetRole,
          seniority: args.seniority,
          intents: ["question", "experience"],
          max: 3,
        }),
        resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);

      // Keep following the loop's shape: the slot we'd be on now decides the
      // stage and type, so the adaptive path can't quietly drop the behavioural
      // half of the interview. Position counts questions ASKED (the session's
      // stored list), not answered — a skipped question never reaches
      // interview_answers, and counting answers would ask that slot again.
      const position = Math.max(stored.length, transcript.length);
      const roundType = args.roundType ?? inferRoundType(stored);
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        // Size the loop to the round planned, or to the session actually in
        // progress if it has run past that, so it never pins to the last slot.
        questionCount: Math.max(args.plannedCount ?? 6, position + 1),
        focusAreas: args.focusAreas,
        ctx,
        profile,
        roundType,
        framework: args.framework,
        frameworkLevel: args.frameworkLevel,
      });
      const slot: QuestionSlot | undefined = blueprint.slots[Math.min(position, blueprint.slots.length - 1)];

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
        roundType,
        framework: args.framework,
        frameworkLevel: args.frameworkLevel,
      });

      const res = await horus.infer({
        task: "interview.next_question",
        system,
        messages: [{ role: "user", content: user }],
        // The interviewer's next question is the interview itself, so it gets
        // the deep model like the opening questions, the scoring and the debrief.
        model: "deep",
        temperature: 0.9,
        userRef: auth.userId,

        userToken: auth.jwt,
      });

      // The adaptive difficulty is this tool's call, not the slot's ramp; the
      // rest of the slot (stage, type, minutes, length band) still holds.
      const question =
        res.data && typeof res.data === "object"
          ? { ...alignToSlot(res.data as object, slot), difficulty, id: position + 1 }
          : res.data;

      // Append to the session so finish_interview sees the full planned loop,
      // not just the questions that happened to be answered.
      await appendSessionQuestion(auth.db, args.sessionId, question);

      return ok({
        question,
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
      const [ctx, transcript, stored] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, { field: args.field, seniority: args.seniority }),
        readTranscript(auth.db, args.sessionId),
        readSessionQuestions(auth.db, args.sessionId),
      ]);
      const roundType = args.roundType ?? inferRoundType(stored);

      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: args.field,
          role: ctx.goal?.targetRole,
          seniority: args.seniority,
          intents: ["experience", "question"],
          max: 3,
        }),
        resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);
      const blueprint = interviewBlueprint({
        field: args.field,
        seniority: args.seniority,
        questionCount: Math.max(transcript.length, args.plannedCount ?? 6),
        ctx,
        profile,
        roundType,
        framework: args.framework,
      });

      // Name each story answer's competency (from the question it answered),
      // so the debrief's story bank uses the same names as the library.
      const labelled = transcript.map((t) => {
        const q = matchStoredQuestion(stored, undefined, t.question);
        return { ...t, competency: isCompetencyKey(q?.competency) ? competencyLabel(q!.competency!, args.seniority) : undefined };
      });
      const tested = new Set(labelled.map((t) => t.competency).filter(Boolean));
      const untested = competencySet({ framework: args.framework, seniority: args.seniority })
        .map((c) => c.label)
        .filter((label) => !tested.has(label));

      const { system, user } = finalEvaluationPrompt({
        field: args.field,
        seniority: args.seniority,
        transcript: labelled,
        coverage: stageCoverage(blueprint, transcript),
        ctx,
        research,
        roundType,
        framework: args.framework,
        untestedCompetencies: untested,
      });
      const res = await horus.infer<{ overallScore?: number }>({
        task: "interview.final_evaluation",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        temperature: 0.2,
        userRef: auth.userId,

        userToken: auth.jwt,
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
            ...(args.durationSeconds !== undefined ? { duration_seconds: args.durationSeconds } : {}),
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
        roundType,
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

        userToken: auth.jwt,
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
  /** Set by alignToSlot; absent on sessions stored before round types. */
  targetWords?: unknown;
  /** Story slots: the competency key the question tests. */
  competency?: string;
}

/** What the evaluator returns — the parts this tool reads. */
interface EvaluationData {
  score?: number;
  scoreBreakdown?: unknown;
  cap?: unknown;
  starBreakdown?: unknown;
  starQuotes?: unknown;
  competency?: unknown;
  storyTitle?: unknown;
}

/**
 * Clients that predate round types send none. Their sessions were full loops,
 * except that a stored phone-screen question can only come from a screen.
 */
function inferRoundType(stored: StoredQuestion[]): RoundType {
  return stored.some((q) => q.stage === "screen") ? "screen" : "full";
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

/**
 * The session so far, oldest first. A question answered more than once (a
 * retry) counts once, as its latest attempt: the debrief judges where they
 * ended up, and the adaptive path must not count a retry as a new question.
 */
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
    const rows = (data ?? []).map((r: any) => ({
      question: String(r.question_text ?? "").trim(),
      type: r.question_type ?? undefined,
      answer: String(r.answer_text ?? ""),
      score: num(r.overall_score) ?? undefined,
    }));
    return latestPerQuestion(rows);
  } catch {
    return [];
  }
}

const questionKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

/** Same question, ignoring case and spacing — how a retry is recognised. */
export function sameQuestion(a: string, b: string): boolean {
  return questionKey(a) === questionKey(b);
}

/** Keep each question's latest answer, in the order the questions were first asked. */
export function latestPerQuestion<T extends { question: string }>(rows: T[]): T[] {
  const key = questionKey;
  const order: string[] = [];
  const latest = new Map<string, T>();
  for (const row of rows) {
    const k = key(row.question);
    if (!latest.has(k)) order.push(k);
    latest.set(k, row);
  }
  return order.map((k) => latest.get(k)!);
}
