/**
 * Expert prompt builders. These are the domain moat — ported and generalized
 * from CareerCraft's interview-ai, now woven with real learner context. Each
 * returns { system, user }; the JSON shape is enforced by Horus.
 */

import { researchIsEmpty, type FieldResearch, type ResearchKind, type ResearchSnippet } from "../adapters/research/port.js";
import { getCareerPath, getSeniorityModifier } from "./career-paths.js";
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

export function generateQuestionsPrompt(args: {
  field: string;
  seniority?: string;
  jobDescription?: string;
  focusAreas?: string[];
  count?: number;
  ctx?: LearnerContext;
  research?: FieldResearch;
}): PromptPair {
  const path = getCareerPath(args.field);
  const mod = getSeniorityModifier(path, args.seniority);
  const count = args.count ?? 6;

  const system = `You are a seasoned hiring manager and interview panelist for ${args.field} roles, with 15+ years designing real interview loops in this exact field.
Principles: open-ended questions, mixed types, progressive difficulty, behavioral questions demand specific examples. Use the language and scenarios that real ${args.field} interviews use — not generic tech-interview tropes unless this IS a tech field.

ROLE FOCUS — ${args.field} (${args.seniority ?? "Mid-Level"}):
- Technical depth weight: ${Math.round(mod.technicalDepth * 100)}%
- Leadership/soft weight: ${Math.round(mod.leadershipFocus * 100)}%
- Key skills: ${path.keySkills.join(", ")}
- Type mix: ~${Math.round(path.technicalWeight * 100)}% technical / ${Math.round(path.behavioralWeight * 100)}% behavioral

Return ONLY JSON:
{
  "analysis": { "roleUnderstanding": string, "keyCompetencies": string[] },
  "questions": [{
    "id": number, "question": string,
    "type": "technical|behavioral|situational|system_design|coding|case_study",
    "difficulty": "easy|medium|hard|expert", "category": string,
    "skillsTested": string[], "expectedTopics": string[], "timeAllocationMinutes": number
  }]
}`;

  const user = `Design ${count} interview questions.
ROLE: ${args.field}
SENIORITY: ${args.seniority ?? "Mid-Level"}
${args.jobDescription ? `JOB DESCRIPTION:\n${args.jobDescription}\n` : ""}${args.focusAreas?.length ? `FOCUS AREAS: ${args.focusAreas.join(", ")}\n` : ""}${contextBlock(args.ctx)}
${realWorldBlock(args.research)}
Bias coverage toward the candidate's weakest skills above without telegraphing it. Make questions specific and revealing${hasResearch(args.research) ? ", and anchored in the real-world signals above (mirror how this field actually interviews)" : ""}.`;

  return { system, user };
}

export function evaluateAnswerPrompt(args: {
  field: string;
  seniority?: string;
  question: string;
  questionType?: string;
  answer: string;
  expectedTopics?: string[];
  ctx?: LearnerContext;
}): PromptPair {
  const system = `You are an elite interview evaluator. Score content (40%), communication (30%), behavioral/STAR (20%), strategic impact (10%).
Scale: 9-10 exceptional, 7-8 strong, 5-6 adequate, 3-4 weak, 1-2 poor. Be constructive and specific.

Return ONLY JSON:
{
  "score": number,
  "scoreBreakdown": { "content": {"score": number}, "communication": {"score": number}, "behavioral": {"score": number}, "strategic": {"score": number} },
  "skillsAssessed": [{ "skill": string, "proficiencyDemonstrated": number, "evidence": string }],
  "validation": { "strengths": string[], "missing": string[], "redFlags": string[] },
  "improvedAnswer": { "rewritten": string, "keyChanges": string[] },
  "coachingTips": [{ "priority": "high|medium|low", "tip": string }],
  "suggestedFollowup": string
}`;

  const user = `Evaluate this answer.
FIELD: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
QUESTION (${args.questionType ?? "general"}): ${args.question}
${args.expectedTopics?.length ? `EXPECTED TOPICS: ${args.expectedTopics.join(", ")}\n` : ""}ANSWER:
"""${args.answer}"""${contextBlock(args.ctx)}`;

  return { system, user };
}

export function finalEvaluationPrompt(args: {
  field: string;
  seniority?: string;
  transcript: Array<{ question: string; type?: string; answer: string; score?: number }>;
  ctx?: LearnerContext;
}): PromptPair {
  const system = `You are a senior talent-acquisition leader writing an interview debrief. Honest, constructive, actionable.
Grades: A+ (95-100) … D/F (<55). Readiness: "Ready" | "Almost Ready" | "Needs Development" | "Not Ready".

Return ONLY JSON:
{
  "overallScore": number, "grade": string, "readiness": string,
  "recommendation": "Strong Hire|Hire|Lean Hire|No Hire|Strong No Hire",
  "executiveSummary": string,
  "strengths": { "top": string[], "notable": string[] },
  "developmentAreas": { "critical": string[], "important": string[] },
  "competencyMatrix": [{ "competency": string, "score": number, "level": string, "developmentNeeded": boolean }],
  "improvementPlan": { "immediate": [{ "area": string, "action": string, "timeline": string }] }
}`;

  const qa = args.transcript
    .map((t, i) => `Q${i + 1} [${t.type ?? "general"}]: ${t.question}\nA${i + 1}: ${t.answer}${t.score != null ? `\n(score ${t.score})` : ""}`)
    .join("\n\n");

  const user = `Final evaluation.
ROLE: ${args.field} | SENIORITY: ${args.seniority ?? "Mid-Level"}
TRANSCRIPT:
${qa}${contextBlock(args.ctx)}`;

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
  const system = `You are a pragmatic credentials advisor for ANY field (trades, healthcare, finance, law, tech…). From the CANDIDATE CREDENTIALS below — a mix of a vetted catalog and credentials researched from real sources — pick the ${args.count} best next moves for THIS learner. Recommend ONLY from that list; never invent a credential. Optimize for hiring/licensing impact per prep hour, sequenced so prerequisites come first.

Return ONLY JSON:
{
  "recommendations": [{
    "certificationId": string|null, "name": string, "priority": number,
    "source": "the source of this credential — 'catalog' or the URL it was researched from (copy it from the candidate line)",
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
CANDIDATE CREDENTIALS (id :: name :: level :: prep hours :: cost :: market signal :: source/notes — id may be "—" for researched ones):
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
    "type": "recall|scenario|code|whiteboard|teach_back",
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

Choose the drill "type" that best builds this skill at this level. timeboxMinutes between 5 and 25.`;

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
