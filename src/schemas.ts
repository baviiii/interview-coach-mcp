import { z } from "zod";

/** Tool input shapes (ZodRawShape — plain objects of zod validators, as the
 *  MCP SDK expects). Identity is NEVER an input; it comes from the JWT. */

export const buildPlanInput = {
  source: z.object({
    type: z.enum(["saved_job", "paste", "role"]),
    jobId: z.string().uuid().optional(),
    jobDescription: z.string().max(20000).optional(),
    field: z.string().optional(),
    seniority: z.string().optional(),
  }),
  timeBudgetMinutes: z.number().int().min(15).max(180).optional(),
  rounds: z.array(z.string()).optional(),
};

export const generateQuestionsInput = {
  field: z.string().min(1),
  seniority: z.string().optional(),
  jobId: z.string().uuid().optional(),
  jobDescription: z.string().max(20000).optional(),
  focusAreas: z.array(z.string()).optional(),
  // Clamp instead of reject: LLM callers routinely ask for 1-2 questions,
  // and a hard minimum turns that into a tool error mid-conversation.
  count: z.coerce
    .number()
    .int()
    .optional()
    .transform((n) => (n === undefined ? undefined : Math.min(Math.max(n, 1), 10))),
};

export const startSessionInput = {
  field: z.string().min(1),
  seniority: z.string().optional(),
  jobId: z.string().uuid().optional(),
  jobDescription: z.string().max(20000).optional(),
  // Round focus (e.g. from build_interview_plan) — steers question coverage.
  focusAreas: z.array(z.string().max(200)).max(12).optional(),
  questionCount: z.coerce
    .number()
    .int()
    .optional()
    .transform((n) => (n === undefined ? undefined : Math.min(Math.max(n, 1), 10))),
};

export const submitAnswerInput = {
  sessionId: z.string().uuid(),
  questionText: z.string().min(1),
  questionType: z.string().optional(),
  answerText: z.string().min(1).max(20000),
  field: z.string().min(1),
  seniority: z.string().optional(),
  expectedTopics: z.array(z.string()).optional(),
  questionId: z.string().uuid().optional(),
  timeTakenSeconds: z.number().int().nonnegative().optional(),
};

export const nextQuestionInput = {
  sessionId: z.string().uuid(),
  field: z.string().min(1),
  seniority: z.string().optional(),
  // Round focus (e.g. from build_interview_plan) — steers what gets probed next.
  focusAreas: z.array(z.string().max(200)).max(12).optional(),
};

export const finishInput = {
  sessionId: z.string().uuid(),
  field: z.string().min(1),
  seniority: z.string().optional(),
};

export const rankResourcesInput = {
  skills: z.array(z.string()).optional(),
  skillIds: z.array(z.string().uuid()).optional(),
  goal: z.string().optional(),
  maxResults: z.number().int().min(1).max(20).optional(),
};

export const learningPathwayInput = {
  /** Overrides the derived targets (defaults: last debrief → weak skills → field). */
  skills: z.array(z.string().max(100)).max(8).optional(),
  field: z.string().max(100).optional(),
  goal: z.string().max(500).optional(),
  weeks: z.number().int().min(1).max(12).optional(),
  hoursPerWeek: z.number().int().min(1).max(60).optional(),
};

export const explainInput = {
  recommendationId: z.string().uuid(),
};

export const provenTipsInput = {
  skill: z.string().optional(),
  question: z.string().max(4000).optional(),
  count: z.number().int().min(1).max(8).optional(),
};

export const provenResourcesInput = {
  skills: z.array(z.string()).optional(),
  goal: z.string().optional(),
  maxResults: z.number().int().min(1).max(12).optional(),
};

export const analyzePatternsInput = {
  field: z.string().optional(),
  seniority: z.string().optional(),
};

export const weeklyInsightInput = {
  field: z.string().optional(),
  seniority: z.string().optional(),
};

/* ── career.* ─────────────────────────────────────────────────────────────── */

export const careerGuidanceInput = {
  question: z.string().max(4000).optional(),
  targetRole: z.string().max(200).optional(),
  targetField: z.string().max(100).optional(),
  horizonMonths: z.number().int().min(1).max(36).optional(),
};

export const analyzeCertificationsInput = {
  targetRole: z.string().max(200).optional(),
  targetField: z.string().max(100).optional(),
};

export const recommendCertificationsInput = {
  targetField: z.string().max(100).optional(),
  seniority: z.string().max(50).optional(),
  budgetUsd: z.number().nonnegative().max(100000).optional(),
  hoursPerWeek: z.number().int().min(1).max(60).optional(),
  count: z.number().int().min(1).max(5).optional(),
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const logCertificationInput = {
  name: z.string().min(2).max(200),
  issuer: z.string().max(200).optional(),
  issueDate: isoDate.optional(),
  expiryDate: isoDate.optional(),
  credentialId: z.string().max(200).optional(),
  credentialUrl: z.string().url().max(500).optional(),
};

export const setCareerGoalInput = {
  targetField: z.string().min(1).max(100),
  targetRole: z.string().max(200).optional(),
  seniority: z.string().max(50).optional(),
  jobRoleType: z.string().max(100).optional(),
  interviewTypes: z.array(z.string().max(50)).max(10).optional(),
};

export const describeFieldInput = {
  field: z.string().min(1).max(100),
};

export const buildRoadmapInput = {
  // Optional: the tool falls back to the learner's stated goal / target job, so
  // the UI doesn't have to re-ask for something they already told us.
  targetRole: z.string().min(2).max(200).optional(),
  targetField: z.string().max(100).optional(),
  horizonWeeks: z.number().int().min(2).max(52).optional(),
  hoursPerWeek: z.number().int().min(1).max(60).optional(),
};

/* ── study.* ──────────────────────────────────────────────────────────────── */

export const buildStudyPlanInput = {
  skills: z.array(z.string().max(100)).max(8).optional(),
  weeks: z.number().int().min(1).max(12).optional(),
  hoursPerWeek: z.number().int().min(1).max(60).optional(),
  goal: z.string().max(500).optional(),
};

export const nextDrillInput = {
  skill: z.string().max(100).optional(),
  field: z.string().max(100).optional(),
};

export const recordDrillResultInput = {
  skill: z.string().min(1).max(100),
  score: z.number().min(0).max(10),
  drillType: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
};

export const explainConceptInput = {
  concept: z.string().min(2).max(200),
  level: z.enum(["eli5", "working", "interview"]).optional(),
  field: z.string().max(100).optional(),
};

export const trackResourceProgressInput = {
  resourceId: z.string().uuid(),
  status: z.enum(["saved", "in_progress", "completed"]),
  progressPercent: z.number().int().min(0).max(100).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(2000).optional(),
};

/* ── interview hint + profile ─────────────────────────────────────────────── */

export const interviewHintInput = {
  sessionId: z.string().uuid().optional(),
  questionText: z.string().min(1).max(4000),
  currentThinking: z.string().max(8000).optional(),
  field: z.string().max(100).optional(),
};

export const refreshPersonaInput = {
  focus: z.string().max(500).optional(),
};
