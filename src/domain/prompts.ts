/**
 * Expert prompt builders. These are the domain moat — ported and generalized
 * from CareerCraft's interview-ai, now woven with real learner context. Each
 * returns { system, user }; the JSON shape is enforced by Horus.
 */

import { researchIsEmpty, type FieldResearch, type ResearchKind, type ResearchSnippet } from "../adapters/research/port.js";
import { DOMAIN_FORMATS, FORMAT_GUIDE, STORED_LEVELS } from "./field-profile.js";
import { blueprintText, type InterviewBlueprint, type InterviewStage } from "./interview-loop.js";
import type { LearnerContext } from "../types.js";

function contextBlock(ctx?: LearnerContext): string {
  if (!ctx) return "";
  const weak = ctx.weakSkills.map((s) => `${s.name} (${s.proficiency}/100, ${s.trend})`).join(", ");
  const strong = ctx.strongSkills.map((s) => s.name).join(", ");
  const certs = (ctx.certifications ?? []).map((c) => `${c.name}${c.status !== "active" ? ` [${c.status}]` : ""}`).join("; ");
  const lines = [
    "\nCANDIDATE CONTEXT (personalize to this — do not read it back verbatim):",
    weak ? `- Weakest tested skills: ${weak}` : "",
    strong ? `- Strongest skills: ${strong}` : "",
    certs ? `- Certifications held: ${certs}` : "",
    ctx.patterns?.weakestQuestionType ? `- Struggles most with: ${ctx.patterns.weakestQuestionType} questions` : "",
    ctx.recentOverallScores.length ? `- Recent session scores: ${ctx.recentOverallScores.join(", ")}` : "",
    ctx.job ? `- Target job: ${ctx.job.title} @ ${ctx.job.company}` : "",
    ctx.job?.gaps?.length ? `- Known gaps vs. that job: ${ctx.job.gaps.join(", ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * The interview-grade candidate block. `contextBlock` above is deliberately
 * thin (it's fine for a drill or a hint), but a mock interview that doesn't
 * know their history, resume, goal or target job can only ask generic
 * questions — which is exactly the complaint this block exists to fix. Every
 * fact here is already assembled in LearnerContext; it was simply never
 * reaching the interview prompts.
 */
function interviewLearnerBlock(ctx?: LearnerContext): string {
  if (!ctx) return "";
  const persona = ctx.persona as { headline?: string; growthEdges?: string[]; coachingTone?: string } | null;
  const skillLines = ctx.skills
    .slice(0, 10)
    .map((s) => `  - ${s.name}: ${s.proficiency}/100 (${s.trend})`)
    .join("\n");

  const lines = [
    "\nTHE CANDIDATE IN FRONT OF YOU — this is a real person with a real history.",
    "Use these specifics to choose the scenarios, the vocabulary and the stakes of your questions. Never quote their profile back at them and never say 'based on your profile'.",
    persona?.headline ? `- Who they are: ${persona.headline}` : "",
    persona?.growthEdges?.length ? `- Known growth edges: ${persona.growthEdges.join(", ")}` : "",
    ctx.goal?.targetRole || ctx.goal?.targetField
      ? `- Stated goal: ${[ctx.goal?.targetRole, ctx.goal?.targetField, ctx.goal?.seniority].filter(Boolean).join(" · ")}`
      : "",
    ctx.resumeSummary ? `- Resume (excerpt — mine this for concrete situations to ask about): ${ctx.resumeSummary}` : "",
    ctx.job ? `- Target job: ${ctx.job.title} @ ${ctx.job.company}${ctx.job.location ? ` (${ctx.job.location})` : ""}` : "",
    ctx.job?.description ? `- That job's description (excerpt): ${ctx.job.description.slice(0, 800)}` : "",
    ctx.job?.gaps?.length ? `- Known gaps vs. that job: ${ctx.job.gaps.join(", ")}` : "",
    skillLines ? `- Tested skill matrix (weakest first):\n${skillLines}` : "- Tested skill matrix: nothing tested yet — calibrate from their resume and goal",
    (ctx.certifications ?? []).length
      ? `- Certifications: ${ctx.certifications.map((c) => `${c.name}${c.status !== "active" ? ` [${c.status}]` : ""}`).join("; ")}`
      : "",
    ctx.patterns?.weakestQuestionType ? `- Historically struggles most with: ${ctx.patterns.weakestQuestionType} questions` : "",
    ctx.patterns?.totalSessions ? `- Practice history: ${ctx.patterns.totalSessions} sessions, trend ${ctx.patterns.overallTrend ?? "unknown"}` : "",
    ctx.recentOverallScores.length ? `- Recent session scores (oldest→newest): ${ctx.recentOverallScores.join(", ")}` : "",
    ctx.applications
      ? `- Job pipeline: ${ctx.applications.total} applications, ${ctx.applications.interviews} in interview. Recent targets: ${ctx.applications.recentTitles.join("; ")}`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Do-not-repeat list built from what this learner has already been asked. */
function avoidBlock(ctx?: LearnerContext, extra: string[] = []): string {
  const themes = [...(ctx?.recentQuestionThemes ?? []), ...extra];
  const unique = [...new Set(themes.map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  if (unique.length === 0) return "";
  return `\nALREADY ASKED THIS CANDIDATE (in this or a recent session) — do not repeat these, and do not ask a near-paraphrase of them:\n${unique
    .map((q) => `  - ${q}`)
    .join("\n")}\n`;
}

/** Clichés that make a mock interview feel like a template. */
const BANNED_QUESTIONS = `Never use these — they are the reason generic mocks feel worthless:
- "Tell me about yourself" / "Walk me through your resume" as a scored question
- "What is your greatest weakness/strength", "Where do you see yourself in 5 years"
- "Why do you want to work here" with no company or JD to ground it
- Textbook trivia with one memorised answer, or a stock puzzle (FizzBuzz, "design a URL shortener", "reverse a linked list") unless the job description explicitly calls for it`;

/** The full career picture — used by career.* and profile.* prompts. */
function careerContextBlock(ctx: LearnerContext): string {
  const skillLines = ctx.skills
    .slice(0, 12)
    .map((s) => `  - ${s.name} (${s.category ?? "general"}): ${s.proficiency}/100, trend ${s.trend}`)
    .join("\n");
  const certLines = (ctx.certifications ?? [])
    .map(
      (c) =>
        `  - ${c.name}${c.issuer ? ` (${c.issuer})` : ""} — status: ${c.status}${
          c.expiryDate ? `, expires ${c.expiryDate}` : ""
        }${c.skills?.length ? `, vouches for: ${c.skills.join(", ")}` : ""}`,
    )
    .join("\n");
  const apps = ctx.applications;
  const lines = [
    "LEARNER PROFILE (ground every claim in this — never invent facts about them):",
    ctx.goal?.targetRole || ctx.goal?.targetField
      ? `- Stated goal: ${[ctx.goal?.targetRole, ctx.goal?.targetField, ctx.goal?.seniority].filter(Boolean).join(" · ")}`
      : "- Stated goal: none recorded yet",
    skillLines ? `- Skill matrix (weakest first):\n${skillLines}` : "- Skill matrix: no tested skills yet",
    certLines ? `- Certifications:\n${certLines}` : "- Certifications: none recorded",
    ctx.recentOverallScores.length
      ? `- Recent interview session scores (oldest→newest): ${ctx.recentOverallScores.join(", ")}`
      : "",
    ctx.patterns?.totalSessions ? `- Practice: ${ctx.patterns.totalSessions} sessions, streak ${ctx.patterns.currentStreakDays ?? 0}d, trend ${ctx.patterns.overallTrend ?? "unknown"}` : "",
    apps
      ? `- Job pipeline: ${apps.total} applications, ${apps.interviews} in interview, ${apps.offers} offers. Recent targets: ${apps.recentTitles.join("; ")}`
      : "",
    ctx.resumeSummary ? `- Resume (excerpt): ${ctx.resumeSummary}` : "",
    ctx.persona ? `- Existing coach persona: ${JSON.stringify(ctx.persona).slice(0, 600)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Renders live research (real, cited posts/pages about the field) into a prompt
 * block. This is what makes generation career-agnostic AND grounded: the model
 * is told to mirror real themes and to only cite/claim credentials that appear
 * here. Empty research → empty string (the tool simply omits the block, no
 * hallucinated "examples"). Each call site passes whatever buckets it fetched.
 */
const KIND_HEADINGS: Record<ResearchKind, string> = {
  question: "Interview questions people in this field actually report",
  experience: "Where candidates struggled / what tripped them up (real accounts)",
  credential: "Credentials, licenses or exams the field expects",
  resource: "Resources the community recommends",
  fact: "Reference facts",
};

const KIND_ORDER: ResearchKind[] = ["question", "experience", "credential", "resource", "fact"];

function researchBucket(r: FieldResearch, kind: ResearchKind): ResearchSnippet[] {
  switch (kind) {
    case "question":
      return r.questions;
    case "experience":
      return r.experiences;
    case "credential":
      return r.credentials;
    case "resource":
      return r.resources;
    case "fact":
      return r.facts;
  }
}

export function realWorldBlock(
  research?: FieldResearch,
  opts: { only?: ResearchKind[]; maxPerKind?: number } = {},
): string {
  if (!research || researchIsEmpty(research)) return "";
  const order = opts.only ?? KIND_ORDER;
  const cap = opts.maxPerKind ?? 4;

  const sections: string[] = [];
  for (const kind of order) {
    const items = researchBucket(research, kind).slice(0, cap);
    if (items.length === 0) continue;
    const lines = items
      .map((s) => `  - ${s.text} [${s.sourceLabel}${s.stat ? `, ${s.stat}` : ""}] (${s.sourceUrl})`)
      .join("\n");
    sections.push(`${KIND_HEADINGS[kind]}:\n${lines}`);
  }
  if (sections.length === 0) return "";

  return (
    `\nREAL-WORLD SIGNALS — real, sourced material about ${research.field} (actual posts/pages, not examples). ` +
    `Ground your output in these: prefer themes that appear here, mirror the real language, and when you name a credential or cite a resource it MUST be one of these (keep its source). ` +
    `Never invent a source, credential, statistic, or "typical" question.` +
    `${research.partial ? " Some sources were unavailable — work with what's here and don't fill gaps with guesses." : ""}\n\n` +
    `${sections.join("\n\n")}\n`
  );
}

/** True when there is real research to lean on (gates "…grounded in the signals above" phrasing). */
function hasResearch(research?: FieldResearch): boolean {
  return !!research && !researchIsEmpty(research);
}

export interface PromptPair {
  system: string;
  user: string;
}

/**
 * Question generation, driven by a deterministic blueprint (domain/interview-loop.ts)
 * rather than by a "~60% technical" hint the model was free to ignore. Every slot
 * is spelled out — stage, type, difficulty, which of the learner's real skills it
 * probes — so behavioural coverage is structural, not hopeful.
 */
export function generateQuestionsPrompt(args: {
  blueprint: InterviewBlueprint;
  jobDescription?: string;
  focusAreas?: string[];
  ctx?: LearnerContext;
  research?: FieldResearch;
}): PromptPair {
  const bp = args.blueprint;
  const types = [...new Set(bp.slots.map((s) => s.type))];
  const formatLines = types.map((t) => `- ${t}: ${FORMAT_GUIDE[t] ?? t}`).join("\n");

  const system = `You are a seasoned hiring manager and interview panelist for ${bp.field} roles, with 15+ years designing real interview loops in this exact field. You are running a live mock interview for one specific candidate.

HOW YOU WRITE QUESTIONS:
- Open-ended, and answerable only by someone who has actually done this work. If the question could be pasted into any interview for any candidate, it is a failed question — rewrite it.
- Anchor each question in something real: this candidate's own history, the target job, or how ${bp.field} genuinely interviews. Behavioural questions must demand a specific past situation, their actions and a measurable result.
- Use the language, scenarios and stakes of real ${bp.field} work — not generic tech-interview tropes unless this IS a tech field.
- Vary phrasing and scenarios; this candidate practises repeatedly and must not recognise the set.

${BANNED_QUESTIONS}

ROLE CALIBRATION — ${bp.field} (${bp.seniority}):
- Craft depth weight: ${Math.round(bp.depth * 100)}%
- Leadership/soft weight: ${Math.round(bp.leadership * 100)}%${
    bp.fieldMatched && bp.keySkills.length ? `\n- Key skills for this field: ${bp.keySkills.join(", ")}` : ""
  }

QUESTION FORMATS IN THIS LOOP:
${formatLines}

Return ONLY JSON:
{
  "analysis": { "roleUnderstanding": string, "keyCompetencies": string[] },
  "questions": [{
    "id": number, "question": string,
    "stage": "warmup|behavioral|domain|situational|closing",
    "type": "${types.join("|")}",
    "difficulty": "easy|medium|hard|expert", "category": string,
    "skillsTested": string[], "expectedTopics": string[], "timeAllocationMinutes": number,
    "whyThisQuestion": "one sentence, addressed to the candidate, on why THEY are being asked this — cite the specific thing about them that prompted it",
    "followUps": ["two probes you would push with if the answer stays shallow"],
    "signalsSought": ["what a strong answer proves"]
  }]
}`;

  const user = `Run the loop below. Produce EXACTLY ${bp.slots.length} questions, one per slot, in this order, keeping each slot's id, stage, type and difficulty exactly as specified.

INTERVIEW LOOP (fill each slot):
${blueprintText(bp)}

ROLE: ${bp.field}
SENIORITY: ${bp.seniority}
${args.jobDescription ? `JOB DESCRIPTION:\n${args.jobDescription}\n` : ""}${
    args.focusAreas?.length ? `THIS ROUND'S FOCUS: ${args.focusAreas.join(", ")} — stay inside it.\n` : ""
  }${interviewLearnerBlock(args.ctx)}
${avoidBlock(args.ctx)}${realWorldBlock(args.research)}
Where a slot names a skill to probe, the question must genuinely test it — bias toward their weakest skills without telegraphing that you are doing so${
    hasResearch(args.research) ? ", and mirror the real-world signals above (how this field actually interviews)" : ""
  }.`;

  return { system, user };
}

/** One adaptive follow-on question mid-session. */
export function nextQuestionPrompt(args: {
  field: string;
  seniority?: string;
  difficulty: string;
  slot?: { stage: InterviewStage; type: string; intent: string };
  focusSkill?: string;
  focusAreas?: string[];
  lastExchange?: { question: string; answer: string; score?: number };
  covered: string[];
  ctx?: LearnerContext;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are the interviewer mid-loop, choosing what to ask next. You have just heard their previous answer, and the question you ask now should feel like it came from a person who was listening — either pressing on what they left thin, or moving deliberately to the next thing you need to see.

${BANNED_QUESTIONS}

Return ONLY JSON for ONE question:
{ "id": number, "question": string, "stage": "warmup|behavioral|domain|situational|closing",
  "type": string, "difficulty": string, "category": string,
  "skillsTested": string[], "expectedTopics": string[],
  "whyThisQuestion": "one sentence to the candidate on why this follows from what they just said or from where they're weakest",
  "followUps": ["two probes if the answer stays shallow"] }
The "difficulty" MUST be "${args.difficulty}".${
    args.slot ? ` The "stage" MUST be "${args.slot.stage}" and the "type" MUST be "${args.slot.type}".` : ""
  }`;

  const user = `FIELD: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
${args.slot ? `THIS SLOT SCREENS FOR: ${args.slot.intent}\n` : ""}${args.focusSkill ? `Probe this weak skill: ${args.focusSkill}.\n` : ""}${
    args.focusAreas?.length ? `THIS ROUND'S FOCUS: ${args.focusAreas.join(", ")}. Stay within it.\n` : ""
  }${
    args.lastExchange
      ? `THEIR PREVIOUS EXCHANGE:\nQ: ${args.lastExchange.question}\nA: ${args.lastExchange.answer.slice(0, 1200)}${
          args.lastExchange.score != null ? `\n(scored ${args.lastExchange.score}/10)` : ""
        }\nIf that answer left something important unproven, press there instead of changing subject.\n`
      : ""
  }${interviewLearnerBlock(args.ctx)}
${avoidBlock(args.ctx, args.covered)}${realWorldBlock(args.research, { only: ["question", "experience"] })}`;

  return { system, user };
}

/**
 * Rubric weights by question type. A behavioural answer graded on "content 40%"
 * scores badly for the wrong reason, and a system-design answer graded on STAR
 * is nonsense — so the weights move with the question while the four reported
 * dimensions stay stable for the UI.
 */
function rubricFor(questionType?: string): { weights: string; emphasis: string; star: boolean } {
  const t = (questionType ?? "").toLowerCase();
  if (/behavior|warmup|closing|leadership/.test(t)) {
    return {
      weights: "content/substance of the story (25%), communication & structure (25%), behavioral evidence — STAR completeness, ownership, specificity (35%), strategic impact — the measurable result and what they learned (15%)",
      emphasis:
        'A story without a specific situation, their OWN actions ("we" everywhere is a red flag) and a concrete outcome cannot score above 5, however fluent it sounds.',
      star: true,
    };
  }
  if (/practical|hands_on/.test(t)) {
    return {
      weights: "content — a correct, safe, standards-compliant approach (45%), communication — can they walk someone through it step by step (20%), behavioral — when they would check, escalate or stop (15%), strategic — judgment about constraints, risk and priorities (20%)",
      emphasis:
        "Score what they would actually DO, in order. Skipping a safety, legal or quality check this field treats as non-negotiable caps the score at 5, however confident the answer sounds.",
      star: false,
    };
  }
  if (/technical|coding|system_design|design/.test(t)) {
    return {
      weights: "content — correctness and technical depth (45%), communication — how clearly they reason aloud (20%), behavioral — how they handle uncertainty and pushback (10%), strategic — trade-offs, constraints and impact (25%)",
      emphasis:
        "Reward naming real trade-offs and failure modes; penalise buzzword recall with no mechanism behind it. A confidently wrong claim is worse than an acknowledged unknown.",
      star: false,
    };
  }
  if (/situational|case/.test(t)) {
    return {
      weights: "content — quality of judgment and the options considered (35%), communication — structure of the reasoning (25%), behavioral — stakeholder awareness (20%), strategic — risk, second-order effects, what they'd do first (20%)",
      emphasis: "There is no single right answer; score the reasoning, the trade-offs surfaced, and whether they committed to a decision.",
      star: false,
    };
  }
  return {
    weights: "content (40%), communication (30%), behavioral (20%), strategic impact (10%)",
    emphasis: "Be constructive and specific.",
    star: false,
  };
}

export function evaluateAnswerPrompt(args: {
  field: string;
  seniority?: string;
  question: string;
  questionType?: string;
  answer: string;
  expectedTopics?: string[];
  /** Earlier exchanges this session — lets the evaluator spot patterns and
   *  avoid repeating coaching the candidate already received. */
  transcript?: Array<{ question: string; answer: string; score?: number }>;
  ctx?: LearnerContext;
}): PromptPair {
  const rubric = rubricFor(args.questionType);

  const system = `You are an elite interview evaluator for ${args.field} roles. Score this answer against the weighting for THIS question type: ${rubric.weights}.
Scale: 9-10 exceptional, 7-8 strong, 5-6 adequate, 3-4 weak, 1-2 poor. ${rubric.emphasis}
Quote their actual words when you praise or criticise — generic feedback is worthless to them. The rewritten answer must use THEIR material (their real experience as given), not an invented one.

Return ONLY JSON:
{
  "score": number,
  "scoreBreakdown": { "content": {"score": number, "note": string}, "communication": {"score": number, "note": string}, "behavioral": {"score": number, "note": string}, "strategic": {"score": number, "note": string} },
  "rubricApplied": "one line naming the weighting you used and why it fits this question type",${
    rubric.star
      ? '\n  "starBreakdown": { "situation": "present|thin|missing", "task": "present|thin|missing", "action": "present|thin|missing", "result": "present|thin|missing", "note": string },'
      : ""
  }
  "skillsAssessed": [{ "skill": string, "proficiencyDemonstrated": number, "evidence": string }],
  "validation": { "strengths": string[], "missing": string[], "redFlags": string[] },
  "improvedAnswer": { "rewritten": string, "keyChanges": string[] },
  "coachingTips": [{ "priority": "high|medium|low", "tip": string }],
  "followUpQuestion": "the question a real interviewer would ask next, given exactly what they just said",
  "suggestedFollowup": string
}`;

  const earlier = (args.transcript ?? [])
    .slice(-4)
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer.slice(0, 600)}${t.score != null ? ` (scored ${t.score})` : ""}`)
    .join("\n\n");

  const user = `Evaluate this answer.
FIELD: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
QUESTION (${args.questionType ?? "general"}): ${args.question}
${args.expectedTopics?.length ? `EXPECTED TOPICS: ${args.expectedTopics.join(", ")}\n` : ""}ANSWER:
"""${args.answer}"""
${earlier ? `\nEARLIER IN THIS SESSION (for pattern-spotting — do not re-coach what they already fixed):\n${earlier}\n` : ""}${contextBlock(args.ctx)}`;

  return { system, user };
}

export function finalEvaluationPrompt(args: {
  field: string;
  seniority?: string;
  transcript: Array<{ question: string; type?: string; answer: string; score?: number }>;
  /** Planned vs answered per stage — lets the debrief separate behavioural from
   *  technical performance instead of averaging them into mush. */
  coverage?: Array<{ stage: string; planned: number; answered: number }>;
  ctx?: LearnerContext;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are a senior talent-acquisition leader writing an interview debrief for ${args.field}. Honest, constructive, actionable — the candidate will read this and act on it.
Grades: A+ (95-100) … D/F (<55). Readiness: "Ready" | "Almost Ready" | "Needs Development" | "Not Ready".
Judge behavioural and domain performance SEPARATELY before you combine them — a candidate who is strong on stories and weak on craft needs to be told exactly that. Ground every claim in something they actually said.

Return ONLY JSON:
{
  "overallScore": number, "grade": string, "readiness": string,
  "recommendation": "Strong Hire|Hire|Lean Hire|No Hire|Strong No Hire",
  "executiveSummary": string,
  "stageBreakdown": [{ "stage": string, "score": number, "verdict": string }],
  "strengths": { "top": string[], "notable": string[] },
  "developmentAreas": { "critical": string[], "important": string[] },
  "competencyMatrix": [{ "competency": string, "score": number, "level": string, "developmentNeeded": boolean }],
  "improvementPlan": { "immediate": [{ "area": string, "action": string, "timeline": string }] },
  "nextSessionFocus": { "skills": ["2-3 skills the next mock should hammer"], "questionTypes": ["the question types they most need reps on"], "why": string }
}`;

  const qa = args.transcript
    .map((t, i) => `Q${i + 1} [${t.type ?? "general"}]: ${t.question}\nA${i + 1}: ${t.answer}${t.score != null ? `\n(score ${t.score})` : ""}`)
    .join("\n\n");

  const coverage = (args.coverage ?? [])
    .map((c) => `- ${c.stage}: ${c.answered}/${c.planned} answered`)
    .join("\n");

  const user = `Final evaluation.
ROLE: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
${coverage ? `LOOP COVERAGE (unanswered stages mean untested competencies — say so rather than assuming):\n${coverage}\n` : ""}
TRANSCRIPT:
${qa}${interviewLearnerBlock(args.ctx)}
${realWorldBlock(args.research, { only: ["experience", "question"] })}
"nextSessionFocus" feeds their study plan directly — make it specific enough to act on tomorrow.`;

  return { system, user };
}

export function rankResourcesPrompt(args: {
  goal?: string;
  skills: string[];
  candidates: Array<{ id: string; title: string; type: string; difficulty?: string; provider?: string }>;
  ctx?: LearnerContext;
}): PromptPair {
  const system = `You are a learning strategist. Rank the candidate resources for THIS learner and goal.
For each, give a priority (1 = do first) and a one-sentence "whyRecommended" grounded in their weak skills and goal.

Return ONLY JSON:
{ "ranked": [{ "id": string, "priority": number, "whyRecommended": string }] }`;

  const list = args.candidates
    .map((c) => `- ${c.id} :: ${c.title} [${c.type}${c.difficulty ? "/" + c.difficulty : ""}${c.provider ? ", " + c.provider : ""}]`)
    .join("\n");

  const user = `GOAL: ${args.goal ?? "improve interview readiness"}
TARGET SKILLS: ${args.skills.join(", ") || "(general)"}
CANDIDATE RESOURCES:
${list}${contextBlock(args.ctx)}`;

  return { system, user };
}

/**
 * Last-resort resource guidance: the resources table is empty for this
 * deployment AND research came back with nothing. Returning an empty list here
 * is what made the pathway look broken, so we ask for learning *moves* instead
 * — clearly flagged as unsourced, never dressed up as a vetted catalogue.
 */
export function suggestResourcesPrompt(args: {
  field: string;
  skills: string[];
  goal?: string;
  count: number;
  ctx?: LearnerContext;
}): PromptPair {
  const system = `You are a learning strategist. No vetted resource catalogue is available for this learner, so recommend ${args.count} concrete LEARNING MOVES they can start this week — the kind of thing a practitioner in this field would actually name (a specific type of practice, a canonical text or standard, a project to build, a person to shadow).
Do NOT invent URLs, course codes, prices or ratings. Name the thing and how to find it.

Return ONLY JSON:
{ "resources": [{ "title": string, "type": "practice|reading|project|course|community", "whyRecommended": string, "priority": number, "howToFind": string }] }`;

  const user = `FIELD: ${args.field}
TARGET SKILLS: ${args.skills.join(", ") || "(general readiness)"}
GOAL: ${args.goal ?? "close the gaps before upcoming interviews"}${contextBlock(args.ctx)}
Order by priority (1 = start here). Each must be specific enough to act on today.`;

  return { system, user };
}

/* ── career.* prompts ──────────────────────────────────────────────────────── */

export function careerGuidancePrompt(args: {
  question?: string;
  targetRole?: string;
  horizonMonths?: number;
  ctx: LearnerContext;
  certFacts: string;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are an elite career strategist — part executive recruiter, part coach — who has placed hundreds of people into ${args.ctx.targetField ?? "their target"} roles. You give direct, specific, evidence-based guidance. Every claim about the learner must trace to their profile; every market claim must be defensible (and when real-world signals are provided below, ground market/credential claims in them). No platitudes ("network more", "be confident") — only moves a serious operator would make.

Return ONLY JSON:
{
  "headline": "One-sentence verdict on their position",
  "assessment": { "whereYouAre": string, "momentum": string, "marketPosition": string },
  "strengthsToSell": [{ "strength": string, "evidence": "which profile fact proves it", "howToPitch": string }],
  "gapsToClose": [{ "gap": string, "severity": "critical|important|nice-to-have", "fastestFix": string }],
  "certificationMoves": [{ "action": "earn|renew|showcase|skip", "certification": string, "why": string, "timeline": string }],
  "trajectoryOptions": [{ "path": string, "viability": number, "whyItFits": string, "firstMilestone": string, "timeToCredible": string }],
  "narrative": { "elevatorPitch": string, "linkedinHeadline": string, "storyArc": "how to frame their history as a deliberate arc toward the goal" },
  "nextActions": [{ "action": string, "impact": "high|medium", "due": "e.g. this week | next 30 days" }]
}`;

  const user = `${careerContextBlock(args.ctx)}

CERTIFICATION FACTS (deterministic, from the curated catalog):
${args.certFacts}
${realWorldBlock(args.research, { only: ["credential", "experience", "fact"] })}
TARGET: ${args.targetRole ?? args.ctx.goal?.targetRole ?? "their stated goal, or the strongest plausible next role"}
HORIZON: ${args.horizonMonths ?? 6} months
${args.question ? `THE LEARNER ASKS: "${args.question}"\nAnswer this question first inside "headline" and "assessment", then complete the rest.` : ""}
Give 2-3 trajectoryOptions (viability 0-100), ordered by viability. Be honest if the goal is a stretch at the horizon.`;

  return { system, user };
}

export function certificationAnalysisPrompt(args: {
  ctx: LearnerContext;
  certFacts: string;
  targetRole?: string;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are a credentials strategist for ANY field who knows exactly which certifications/licenses move hiring decisions and which are wall décor. Analyze the learner's certification portfolio against their target. Be blunt about low-value or expired credentials. When real-world signals list the credentials the field expects, judge coverage and gaps against THOSE, not against tech defaults.

Return ONLY JSON:
{
  "portfolioVerdict": "one-paragraph honest assessment",
  "coverage": { "covered": ["competency areas their certs credibly prove"], "missing": ["areas the target role expects that no cert/skill covers"], "redundant": ["overlapping certs, if any"] },
  "expiryAlerts": [{ "certification": string, "status": "expired|expiring_soon", "action": "renew|let lapse and why" }],
  "marketValue": [{ "certification": string, "value": "high|medium|low", "why": string }],
  "interviewTalkingPoints": [{ "certification": string, "talkingPoint": "how to convert this cert into an interview story" }],
  "gapsVsTarget": ["concrete cert-shaped gaps vs the target, hardest-hitting first"]
}`;

  const user = `${careerContextBlock(args.ctx)}

CERTIFICATION FACTS (deterministic, from the curated catalog):
${args.certFacts}
${realWorldBlock(args.research, { only: ["credential", "fact"] })}
TARGET ROLE: ${args.targetRole ?? args.ctx.goal?.targetRole ?? args.ctx.targetField ?? "their stated goal"}
Anchor "marketValue" in the marketSignal lines and any real-world signals above; do not inflate unknown certs.`;

  return { system, user };
}

export function certificationRecommendPrompt(args: {
  ctx: LearnerContext;
  candidates: string;
  budgetUsd?: number;
  hoursPerWeek?: number;
  count: number;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are a pragmatic credentials advisor for ANY field (trades, healthcare, finance, law, tech…). From the CANDIDATE CREDENTIALS below — credentials researched from real sources, plus ones this field is known to expect — pick the ${args.count} best next moves for THIS learner. Recommend ONLY from that list; never invent a credential. Optimize for hiring/licensing impact per prep hour, sequenced so prerequisites and legally required licences come first. For a candidate whose source is "model knowledge", say in whyThisOne that the learner should confirm current requirements with the issuing body.

Return ONLY JSON:
{
  "recommendations": [{
    "certificationId": string|null, "name": string, "priority": number,
    "source": "the source of this credential — the URL it was researched from, or 'model knowledge' (copy it from the candidate line)",
    "whyThisOne": "tied to their goal, gaps and existing certs",
    "prepPlan": "2-3 sentence prep approach given their weekly hours",
    "estimatedWeeks": number, "examCostUsd": number|null,
    "roi": "what doors it opens, concretely"
  }],
  "skipForNow": [{ "name": string, "why": string }],
  "sequencingNote": "one sentence on the order"
}`;

  const user = `${careerContextBlock(args.ctx)}
${realWorldBlock(args.research, { only: ["credential", "fact"] })}
CANDIDATE CREDENTIALS (id :: name :: level :: prep hours :: cost :: market signal :: source/notes — id is "—" unless the catalog has facts for it):
${args.candidates}

CONSTRAINTS: budget ${args.budgetUsd ? `$${args.budgetUsd}` : "not stated"}; study time ${args.hoursPerWeek ?? 5} h/week.
estimatedWeeks must follow from prep hours ÷ weekly hours, rounded sensibly. If a credential has no catalog cost, set examCostUsd to null rather than guessing.`;

  return { system, user };
}

export function careerRoadmapPrompt(args: {
  targetRole: string;
  ctx: LearnerContext;
  skeleton: string;
  certShortlist: string;
  certFacts: string;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are a career-transition architect for ANY field. Build a concrete, week-addressed roadmap that takes THIS learner to the target role. Respect the PHASE SKELETON exactly (names, week ranges, cadence) — you fill each phase with personalized content. Every skill target must start from their real current proficiency. Actions must be checkable ("doneWhen"), not vibes. When real-world signals are provided, the certificationTrack and skill targets must reflect the credentials and pain points the field actually has.

Return ONLY JSON:
{
  "title": string,
  "northStar": "the single outcome that defines success",
  "phases": [{
    "name": string, "weeks": "e.g. 1-3", "objective": string,
    "skillTargets": [{ "skill": string, "from": number, "to": number }],
    "actions": [{ "type": "study|practice|interview|certification|project|networking", "action": string, "cadence": string, "doneWhen": string }],
    "checkpoint": { "test": "how to verify the phase landed", "passBar": string }
  }],
  "certificationTrack": [{ "certification": string, "targetWeek": number, "why": string }],
  "interviewCadence": { "mocksPerWeek": number, "focusRotation": ["what each mock emphasizes, rotating"] },
  "weeklyRhythm": [{ "day": string, "block": string, "minutes": number }],
  "riskFactors": [{ "risk": string, "mitigation": string }]
}`;

  const user = `${careerContextBlock(args.ctx)}

CERTIFICATION FACTS:
${args.certFacts}
${realWorldBlock(args.research, { only: ["credential", "experience", "fact"] })}
CERT SHORTLIST (vetted next options — use 0-2 of these in certificationTrack, only if they truly serve the target):
${args.certShortlist}

PHASE SKELETON (follow exactly):
${args.skeleton}

TARGET ROLE: ${args.targetRole}
The weeklyRhythm must fit inside their weekly hours from the skeleton. interviewCadence.mocksPerWeek must match the skeleton's mocksPerWeek.`;

  return { system, user };
}

/* ── study.* prompts ───────────────────────────────────────────────────────── */

export function studyPlanPrompt(args: {
  weeks: number;
  hoursPerWeek: number;
  skillTargets: Array<{ skill: string; from: number; to: number }>;
  resourceCandidates: string;
  goal?: string;
  ctx: LearnerContext;
  research?: FieldResearch;
}): PromptPair {
  const system = `You are a learning scientist designing a deliberate-practice study plan. Principles: spaced repetition over cramming, retrieval practice over re-reading, one theme per week, every session has a concrete output. Sessions must sum to roughly the weekly hour budget — never overload.

Return ONLY JSON:
{
  "goal": string,
  "weeks": [{
    "week": number, "theme": string, "targetSkills": string[],
    "sessions": [{ "day": "Mon|Tue|...", "minutes": number, "method": "learn|drill|build|mock|review", "activity": "specific, checkable task", "skill": string, "resourceTitle": string|null }],
    "milestone": "what is true at week's end"
  }],
  "spacedReviewRules": ["2-3 standing rules, e.g. 'every Friday re-drill the weakest skill from 2 weeks ago'"],
  "successMetric": "the one number that proves the plan worked"
}`;

  const targets = args.skillTargets.map((t) => `- ${t.skill}: ${t.from} → ${t.to}`).join("\n");
  const user = `${contextBlock(args.ctx)}
${realWorldBlock(args.research, { only: ["resource", "experience"] })}
PLAN SHAPE: ${args.weeks} weeks × ${args.hoursPerWeek} h/week.
GOAL: ${args.goal ?? "close the gaps below before upcoming interviews"}
SKILL TARGETS (current → target proficiency):
${targets}

REAL RESOURCE CANDIDATES (use resourceTitle from this list when one fits, else null):
${args.resourceCandidates || "(none available — set resourceTitle to null)"}

Weight early weeks toward the weakest skill; close with mock-interview integration.`;

  return { system, user };
}

export function drillPrompt(args: {
  skill: string;
  difficulty: string;
  field?: string;
  ctx: LearnerContext;
}): PromptPair {
  const system = `You are a drill-master generating ONE focused practice exercise. It must be answerable in one sitting, self-checkable, and at exactly the requested difficulty.

Return ONLY JSON:
{
  "drill": {
    "skill": string,
    "type": "recall|scenario|hands_on|teach_back",
    "prompt": "the exercise itself — specific and self-contained",
    "difficulty": string,
    "timeboxMinutes": number,
    "idealAnswerPoints": ["what a strong answer must include"],
    "selfCheck": ["questions the learner asks themselves to grade their attempt"]
  }
}`;

  const user = `SKILL: ${args.skill}
DIFFICULTY: ${args.difficulty} (must match exactly)
FIELD: ${args.field ?? args.ctx.targetField ?? "their field"}${contextBlock(args.ctx)}

Choose the drill "type" that best builds this skill at this level. "hands_on" means doing the real work of this field in miniature — writing code for a developer, calculating a dose for a nurse, drafting a clause for a paralegal. timeboxMinutes between 5 and 25.`;

  return { system, user };
}

export function explainConceptPrompt(args: {
  concept: string;
  level: "eli5" | "working" | "interview";
  field?: string;
  ctx: LearnerContext;
}): PromptPair {
  const system = `You are a master teacher (Feynman-style). Explain the concept in three ascending layers, with one genuinely worked example and the traps interviewers set around it.

Return ONLY JSON:
{
  "concept": string,
  "levels": { "intuition": "plain-language mental model", "working": "practitioner-level mechanics", "interviewGrade": "the depth a strong candidate shows, incl. trade-offs" },
  "workedExample": "one concrete example worked end-to-end",
  "commonPitfalls": string[],
  "interviewAngles": ["how interviewers actually probe this"],
  "checkYourself": [{ "question": string, "answerSketch": string }],
  "relatedConcepts": string[]
}`;

  const user = `CONCEPT: ${args.concept}
PRIMARY LEVEL THE LEARNER NEEDS: ${args.level}
FIELD: ${args.field ?? args.ctx.targetField ?? "their field"}${contextBlock(args.ctx)}

Make "workedExample" specific to their field. Keep "intuition" jargon-free.`;

  return { system, user };
}

/* ── interview hint + persona prompts ─────────────────────────────────────── */

export function hintPrompt(args: {
  question: string;
  currentThinking?: string;
  struggling: boolean;
  ctx: LearnerContext;
}): PromptPair {
  const system = `You are an interview coach whispering ONE hint mid-question. Never give the answer — unblock their thinking. Calibrate: a learner doing fine gets a gentle nudge; one who is struggling gets structure.

Return ONLY JSON:
{ "hint": "one or two sentences", "level": "gentle|directional|structural", "framework": "a named framework/structure to apply, or null", "followupThought": "the question they should ask themselves next" }`;

  const user = `QUESTION: ${args.question}
${args.currentThinking ? `THEIR THINKING SO FAR: """${args.currentThinking}"""` : "THEIR THINKING SO FAR: (not shared)"}
PERFORMANCE SIGNAL: ${args.struggling ? "struggling this session — give structural help" : "doing okay — stay light"}${contextBlock(args.ctx)}`;

  return { system, user };
}

export function personaSynthesisPrompt(args: {
  ctx: LearnerContext;
  onboarding?: unknown;
  certFacts: string;
}): PromptPair {
  const system = `You are the memory of an AI career coach. Synthesize everything known about this learner into a compact persona that future coaching sessions condition on. Be specific and evidence-based; this object IS the personalization.

Return ONLY JSON:
{
  "persona": {
    "headline": "one line: who they are professionally",
    "careerStage": string,
    "trajectory": "where the evidence says they're heading",
    "superpowers": string[],
    "growthEdges": string[],
    "learningStyle": "inferred from practice patterns",
    "motivators": string[],
    "riskFlags": ["patterns that could derail them, stated kindly"],
    "coachingTone": "how the coach should talk to this person",
    "summary": "3-4 sentence narrative"
  },
  "confidence": number,
  "basedOn": ["which signals drove this synthesis"]
}`;

  const user = `${careerContextBlock(args.ctx)}

CERTIFICATION FACTS:
${args.certFacts}
${args.onboarding ? `\nONBOARDING ANALYSIS (earlier AI read of their resume/story):\n${JSON.stringify(args.onboarding).slice(0, 1500)}` : ""}

confidence 0-1 reflecting how much real signal exists. List basedOn honestly — if data is thin, say so and keep the persona conservative.`;

  return { system, user };
}

/**
 * Describe how one occupation hires — the input that replaced the hardcoded
 * career-path table. Field-level, not learner-level, so it is cached per field.
 */
export function fieldProfilePrompt(args: { field: string; role?: string }): PromptPair {
  const system = `You are a labour-market analyst who knows how hiring actually works in EVERY occupation — trades, healthcare, hospitality, law, finance, education, government, tech and everything between. Describe how employers in the given field interview and what they screen for. Be concrete to this field; do not default to software or corporate-office assumptions unless the field is one.

The field is typed by a learner, so it may be slang, misspelt or vague ("sparky", "nurse icu", "chippy").

Return ONLY JSON:
{
  "isOccupation": "boolean — false if the input is not a recognisable job or field of work (gibberish, a company name, a hobby); then the other keys don't matter",
  "canonicalTitle": "the standard job title for what they typed, as employers advertise it ('sparky' → 'Electrician', 'nurse icu' → 'Intensive Care Nurse'); repeat their words if already standard",
  "levels": { ${STORED_LEVELS.map((l) => `"${l}": "what this stage is called in this field"`).join(", ")} },
  "keySkills": ["4-6 core competencies interviews in this field test, in the field's own vocabulary"],
  "technicalWeight": "number 0.2-0.8 — the share of a typical interview spent on craft knowledge rather than behaviour",
  "domainFormats": ["which of ${DOMAIN_FORMATS.join(" | ")} this field's interviews really use, most typical first — only include coding or system_design if candidates are genuinely asked to write code or design software"],
  "credentials": [{ "name": "exact licence/certification name", "required": "boolean — true if needed to legally or practically work in the field", "note": "one line on who issues it and when it matters" }]
}
For "levels", use 1-4 words each, as people in this field say them (an electrician's entry stage is "Apprentice", a nurse's is "Graduate nurse"), and leave out stages this field doesn't really have.
List at most 6 credentials, and only real ones you are confident exist. Credentials means licences, registrations and certifications — never degrees or diplomas of general education. If the field has none that matter, return an empty list.`;

  const user = `FIELD: ${args.field}${args.role ? `\nTARGET ROLE: ${args.role}` : ""}`;

  return { system, user };
}
