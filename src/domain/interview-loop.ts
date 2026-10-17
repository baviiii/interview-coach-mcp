/**
 * Interview session blueprint — the deterministic skeleton of a mock loop.
 *
 * Same division of labour as `domain/roadmap.ts`: WE decide the structure
 * (how many questions, of which type, at which difficulty, probing which of the
 * learner's real skills) and the model only fills each slot with content. The
 * previous approach — telling the model "~60% technical / 40% behavioral" in
 * prose — was routinely ignored, so a "full interview" could come back with no
 * behavioral question at all. Slots make that impossible.
 *
 * A session is one of four round types, and each has its own skeleton:
 *
 *   full        the mixed loop a final round runs (unchanged from before)
 *   behavioral  past situations only, one competency per question
 *   technical   the work itself: method, judgment, trade-offs; no stories
 *   screen      the recruiter's first call: pitch, motivation, salary, notice
 *
 * Before round types existed, the picker on the web only appended a "focus"
 * line to the prompt, which contradicted this skeleton — a "behavioural"
 * session still got technical slots. The type now decides the skeleton itself.
 */

import {
  competencySet,
  orderByStoryNeed,
  type Competency,
  type FrameworkId,
} from "./competencies.js";
import { neutralProfile, seniorityBand, seniorityWeights, type FieldProfile } from "./field-profile.js";
import type { Difficulty } from "./taxonomy.js";
import type { LearnerContext } from "../types.js";

export const ROUND_TYPES = ["full", "behavioral", "technical", "screen"] as const;
export type RoundType = (typeof ROUND_TYPES)[number];

/** How each round type is named to the learner (and in prompts that talk about their practice). */
export const ROUND_LABELS: Record<RoundType, string> = {
  screen: "Phone screen",
  behavioral: "Behavioural",
  technical: "Technical",
  full: "Full interview",
};

/** Anything unknown (older clients, a typo, nothing at all) is a full loop. */
export function parseRoundType(raw: unknown): RoundType {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "behavioural") return "behavioral";
  return (ROUND_TYPES as readonly string[]).includes(s) ? (s as RoundType) : "full";
}

export type InterviewStage = "warmup" | "behavioral" | "domain" | "situational" | "closing" | "screen";

/** The parts of a recruiter phone screen, in the order a recruiter runs them. */
export const SCREEN_TYPES = ["pitch", "motivation", "experience", "salary", "logistics", "questions"] as const;
export type ScreenType = (typeof SCREEN_TYPES)[number];

/**
 * A healthy written answer length, in words. Answers here are typed but stand
 * in for spoken ones, so the bands come from speaking time at ~150 words a
 * minute: a recruiter wants a pitch in 30-90 seconds, a STAR story in 1-2.5
 * minutes. Craft questions get no band — depth matters there, not length.
 */
export interface WordBand {
  min: number;
  max: number;
}

export interface QuestionSlot {
  /** 1-based position in the loop — also the question `id` the model must use. */
  index: number;
  stage: InterviewStage;
  /** "behavioral", "situational", a screen part, or one of the field profile's domain formats. */
  type: string;
  difficulty: Difficulty;
  /** The learner's real skill this slot exists to probe, when we know one. */
  targetSkill?: string;
  /** What this slot screens for — goes into the prompt verbatim. */
  intent: string;
  /** Time budget for the answer. Fixed here so the room's timer means the same thing every session. */
  minutes: number;
  /** Healthy answer length, when length is part of what's being judged. */
  targetWords?: WordBand;
  /** Story slots: the competency this question tests (a key from domain/competencies.ts). */
  competency?: string;
  competencyLabel?: string;
}

export interface InterviewBlueprint {
  roundType: RoundType;
  /** Set when the panel marks against a public-sector capability framework. */
  framework?: FrameworkId;
  /** The framework level story questions are pitched at (NSW levels, e.g. "Adept"). */
  frameworkLevel?: string;
  field: string;
  seniority: string;
  /** False when no field profile could be derived — callers then omit key-skill
   *  guidance instead of asserting it. */
  fieldMatched: boolean;
  /** Empty when the field profile is neutral. */
  keySkills: string[];
  /** Seniority-driven emphasis, 0-1. */
  depth: number;
  leadership: number;
  slots: QuestionSlot[];
  behavioralCount: number;
}

const STAGE_INTENT: Record<Exclude<InterviewStage, "screen">, string> = {
  warmup:
    "open the loop — get them talking about their actual background and why this role, using something concrete from their history",
  behavioral:
    "past behaviour under pressure — demand a specific real situation, their own actions, and a measurable result (STAR)",
  domain: "depth in the craft itself — probe whether they can reason, not just recall",
  situational: "judgment on a realistic dilemma this role hits — no single right answer, the reasoning is the signal",
  closing: "role fit and self-direction — what they'd want to know, and how they'd ramp in the first 90 days",
};

const STAGE_MINUTES: Record<InterviewStage, number> = {
  warmup: 4,
  behavioral: 5,
  domain: 7,
  situational: 6,
  closing: 3,
  screen: 2,
};

const STORY_WORDS: WordBand = { min: 150, max: 400 };
const CLOSING_WORDS: WordBand = { min: 60, max: 220 };

/** Difficulty ramp: warm up, build, peak near the end. Ceiling follows seniority. */
function rampDifficulty(position: number, total: number, seniority: string): Difficulty {
  const band = seniorityBand(seniority);
  const senior = band === "senior" || band === "lead" || band === "manager";
  const junior = band === "junior";
  const progress = total <= 1 ? 0.5 : position / (total - 1); // 0 → 1

  if (junior) return progress < 0.5 ? "easy" : "medium";
  if (senior) {
    if (progress < 0.3) return "medium";
    if (progress < 0.75) return "hard";
    return "expert";
  }
  if (progress < 0.25) return "easy";
  if (progress < 0.75) return "medium";
  return "hard";
}

/**
 * Skills to probe, weakest first: the learner's real matrix, then anything the
 * round asked for, then the field's key skills. Behavioral slots prefer skills
 * categorised behavioural/soft; domain slots prefer everything else.
 */
function skillPool(ctx: LearnerContext | undefined, focusAreas: string[], keySkills: string[], behavioral: boolean): string[] {
  const isBehavioral = (s: { name: string; category?: string }) =>
    /behavior|soft|communication|leadership|teamwork|adaptab/i.test(`${s.category ?? ""} ${s.name}`);

  const fromMatrix = (ctx?.skills ?? [])
    .filter((s) => (behavioral ? isBehavioral(s) : !isBehavioral(s)))
    .sort((a, b) => a.proficiency - b.proficiency)
    .map((s) => s.name);

  const pool = [...fromMatrix, ...(behavioral ? [] : focusAreas), ...keySkills];
  return [...new Set(pool.filter(Boolean))];
}

export interface BlueprintArgs {
  field: string;
  seniority?: string;
  questionCount?: number;
  focusAreas?: string[];
  ctx?: LearnerContext;
  /** How this field hires (context/field-profile.ts). Neutral when absent. */
  profile?: FieldProfile;
  /** Which kind of round this is. Defaults to the full mixed loop. */
  roundType?: RoundType;
  /** Public-sector framework the panel marks against: story slots use its capabilities. */
  framework?: FrameworkId;
  frameworkLevel?: string;
  /** Put this competency first (practising one story from the library). */
  firstCompetency?: string;
}

interface LoopInputs {
  count: number;
  seniority: string;
  profile: FieldProfile;
  matched: boolean;
  keySkills: string[];
  focusAreas: string[];
  mod: { depth: number; leadership: number };
  ctx?: LearnerContext;
  /** Story competencies in the order this learner needs them. */
  competencies: Competency[];
}

/**
 * The competencies story slots take, in order: the framework's (or the plain
 * set), the ones they have no or weak story for first, and an explicitly
 * requested one ahead of all of them.
 */
function storyCompetencies(args: BlueprintArgs, seniority: string): Competency[] {
  const ordered = orderByStoryNeed(competencySet({ framework: args.framework, seniority }), args.ctx?.stories);
  const first = ordered.find((c) => c.key === args.firstCompetency);
  return first ? [first, ...ordered.filter((c) => c !== first)] : ordered;
}

/** A story slot's competency fields. */
function storyFields(c: Competency | undefined): Pick<QuestionSlot, "competency" | "competencyLabel"> {
  return c ? { competency: c.key, competencyLabel: c.label } : {};
}

export function interviewBlueprint(args: BlueprintArgs): InterviewBlueprint {
  const roundType = args.roundType ?? "full";
  const profile = args.profile ?? neutralProfile(args.field);
  const matched = profile.source === "model" && profile.keySkills.length > 0;
  const seniority = args.seniority ?? "Mid-Level";
  const inputs: LoopInputs = {
    count: Math.min(Math.max(args.questionCount ?? 6, 1), 10),
    seniority,
    profile,
    matched,
    keySkills: matched ? profile.keySkills : [],
    focusAreas: args.focusAreas ?? [],
    mod: seniorityWeights(seniority),
    ctx: args.ctx,
    competencies: storyCompetencies(args, seniority),
  };

  const slots =
    roundType === "behavioral"
      ? behavioralLoop(inputs)
      : roundType === "technical"
        ? technicalLoop(inputs)
        : roundType === "screen"
          ? screenLoop(inputs)
          : fullLoop(inputs);

  return {
    roundType,
    framework: args.framework,
    frameworkLevel: args.framework ? args.frameworkLevel : undefined,
    field: args.field,
    seniority,
    fieldMatched: matched,
    keySkills: inputs.keySkills,
    depth: inputs.mod.depth,
    leadership: inputs.mod.leadership,
    slots,
    behavioralCount: slots.filter((s) => s.stage === "behavioral").length,
  };
}

/* ── full: the mixed loop ─────────────────────────────────────────────────── */

function fullLoop({ count, seniority, profile, keySkills, focusAreas, mod, ctx, competencies }: LoopInputs): QuestionSlot[] {
  // Slot budget. Warmup/closing/situational are only affordable in a real loop;
  // short sets spend everything on behavioral + domain.
  const warmup = count >= 5 ? 1 : 0;
  const closing = count >= 6 ? 1 : 0;
  const situational = count >= 4 ? 1 : 0;
  const core = count - warmup - closing - situational;

  // The behavioral floor is the point of this loop: a full interview ALWAYS
  // carries at least two behavioural questions, whatever the field's technical bias.
  const floor = count >= 4 ? 2 : 1;
  const weighted = Math.round(core * (1 - profile.technicalWeight + mod.leadership * 0.15));
  let behavioral = Math.max(0, Math.min(core - 1, Math.max(floor, weighted)));
  if (core === 1 && /behavioral/i.test(ctx?.patterns?.weakestQuestionType ?? "")) behavioral = 1;
  const domain = core - behavioral;

  const behavioralSkills = skillPool(ctx, focusAreas, keySkills, true);
  const domainSkills = skillPool(ctx, focusAreas, keySkills, false);
  const types = profile.domainFormats;

  // Order: warmup → alternate domain/behavioral → situational → closing.
  const middle: InterviewStage[] = [];
  let d = domain;
  let b = behavioral;
  while (d > 0 || b > 0) {
    if (d > 0) {
      middle.push("domain");
      d -= 1;
    }
    if (b > 0) {
      middle.push("behavioral");
      b -= 1;
    }
  }
  const stages: InterviewStage[] = [
    ...(warmup ? (["warmup"] as InterviewStage[]) : []),
    ...middle,
    ...(situational ? (["situational"] as InterviewStage[]) : []),
    ...(closing ? (["closing"] as InterviewStage[]) : []),
  ];

  let domainSeen = 0;
  let behavioralSeen = 0;
  return stages.map((stage, i) => {
    let type = "behavioral";
    let targetSkill: string | undefined;

    if (stage === "domain") {
      type = types[domainSeen % types.length]!;
      targetSkill = domainSkills[domainSeen % Math.max(domainSkills.length, 1)];
      domainSeen += 1;
    } else if (stage === "behavioral") {
      targetSkill = behavioralSkills[behavioralSeen % Math.max(behavioralSkills.length, 1)];
      behavioralSeen += 1;
    } else if (stage === "situational") {
      type = "situational";
      targetSkill = domainSkills[0] ?? behavioralSkills[0];
    }

    const difficulty: Difficulty =
      stage === "warmup" || stage === "closing" ? "easy" : rampDifficulty(i, stages.length, seniority);
    // Behavioural slots in a full loop name their competency too, so every
    // story told anywhere lands in the right place in the story library.
    const competency = stage === "behavioral" ? competencies[(behavioralSeen - 1) % competencies.length] : undefined;

    return {
      index: i + 1,
      stage,
      type,
      difficulty,
      targetSkill,
      intent: competency
        ? `${competency.intent}. ${STAGE_INTENT.behavioral}`
        : STAGE_INTENT[stage as Exclude<InterviewStage, "screen">],
      minutes: STAGE_MINUTES[stage],
      targetWords: stage === "behavioral" || stage === "warmup" ? STORY_WORDS : stage === "closing" ? CLOSING_WORDS : undefined,
      ...storyFields(competency),
    };
  });
}

/* ── behavioral: one competency per story ─────────────────────────────────── */

/**
 * Each story question takes a different competency (domain/competencies.ts),
 * so a six-question round leaves the learner with six different stories rather
 * than six angles on the same project — and the ones they have no story for
 * yet come first.
 */
function behavioralLoop({ count, seniority, keySkills, focusAreas, ctx, competencies }: LoopInputs): QuestionSlot[] {
  // A one-question drill is the story itself, not a warm-up.
  const warmup = count >= 5 ? 1 : 0;
  const closing = count >= 6 ? 1 : 0;
  const stories = count - warmup - closing;
  // Weak soft skills from their own matrix first; focus areas (e.g. the debrief's
  // weak spots) can only steer behavioural stories here.
  const skills = [...skillPool(ctx, [], keySkills, true), ...focusAreas];

  const slots: Omit<QuestionSlot, "index">[] = [];
  if (warmup) {
    slots.push({
      stage: "warmup",
      type: "behavioral",
      difficulty: "easy",
      intent:
        "open on a recent piece of work they're proud of — a short, real story that gets them talking; still a past situation, not a CV recital",
      minutes: STAGE_MINUTES.warmup,
      targetWords: STORY_WORDS,
    });
  }
  for (let i = 0; i < stories; i += 1) {
    const competency = competencies[i % competencies.length]!;
    slots.push({
      stage: "behavioral",
      type: "behavioral",
      difficulty: rampDifficulty(warmup + i, count, seniority),
      targetSkill: skills.length ? skills[i % skills.length] : undefined,
      intent: `${competency.intent}. Ask for one specific past situation — their own actions and a measurable result (STAR)`,
      minutes: STAGE_MINUTES.behavioral,
      targetWords: STORY_WORDS,
      ...storyFields(competency),
    });
  }
  if (closing) {
    slots.push({
      stage: "closing",
      type: "behavioral",
      difficulty: "easy",
      intent:
        "motivation and fit — a past decision about their career (a move they made, a role they turned down) that shows what they want next",
      minutes: STAGE_MINUTES.closing,
      targetWords: CLOSING_WORDS,
    });
  }
  return slots.map((s, i) => ({ ...s, index: i + 1 }));
}

/* ── technical: the work itself ───────────────────────────────────────────── */

function technicalLoop({ count, seniority, profile, keySkills, focusAreas, ctx }: LoopInputs): QuestionSlot[] {
  // A short, easy opener on familiar ground, then depth, then one judgment call
  // at the end where the stakes are highest. No stories in this round.
  const opener = count >= 5 ? 1 : 0;
  const situational = count >= 4 ? 1 : 0;
  const depth = count - opener - situational;
  const skills = skillPool(ctx, focusAreas, keySkills, false);
  const types = profile.domainFormats;

  const slots: Omit<QuestionSlot, "index">[] = [];
  if (opener) {
    slots.push({
      stage: "domain",
      type: types[0]!,
      difficulty: "easy",
      targetSkill: skills[0],
      intent: "open on familiar ground — how they'd approach a core, everyday task of this job, explained step by step",
      minutes: 5,
    });
  }
  for (let i = 0; i < depth; i += 1) {
    const position = opener + i;
    slots.push({
      stage: "domain",
      type: types[(i + opener) % types.length]!,
      difficulty: rampDifficulty(position, count, seniority),
      targetSkill: skills.length ? skills[(i + opener) % skills.length] : undefined,
      intent: STAGE_INTENT.domain,
      minutes: STAGE_MINUTES.domain,
    });
  }
  if (situational) {
    slots.push({
      stage: "situational",
      type: "situational",
      difficulty: rampDifficulty(count - 1, count, seniority),
      targetSkill: skills[0],
      intent:
        "a realistic dilemma in the work itself — constraints pull in different directions and they must commit to a decision and defend the trade-off",
      minutes: STAGE_MINUTES.situational,
    });
  }
  return slots.map((s, i) => ({ ...s, index: i + 1 }));
}

/* ── screen: the recruiter's first call ───────────────────────────────────── */

const SCREEN_PARTS: Record<ScreenType, { intent: string; difficulty: Difficulty; targetWords: WordBand }> = {
  pitch: {
    intent:
      "the 60-90 second version of who they are, what they've done that matters for THIS job, and why they're looking now — the recruiter decides here whether to keep listening",
    difficulty: "easy",
    targetWords: { min: 75, max: 225 },
  },
  motivation: {
    intent:
      "why this role (and this employer, when the ad names one) — tests whether they read the ad and can tie it to where they're heading",
    difficulty: "medium",
    targetWords: { min: 50, max: 180 },
  },
  experience: {
    intent:
      "a quick check they've really done the core thing this job needs — one concrete example, briefly; a recruiter wants a yes with proof, not a full STAR essay",
    difficulty: "medium",
    targetWords: { min: 60, max: 200 },
  },
  salary: {
    intent:
      "salary expectations — Australian recruiters ask for a figure and whether it's base or package including super; a strong answer gives a researched range, says base vs super, and neither undersells nor dodges",
    difficulty: "medium",
    targetWords: { min: 20, max: 110 },
  },
  logistics: {
    intent:
      "logistics — notice period, when they could start, working rights in Australia, and location or hybrid fit; short, clear, no surprises later",
    difficulty: "easy",
    targetWords: { min: 20, max: 110 },
  },
  questions: {
    intent:
      "'Do you have any questions for me?' — they should ask one or two sharp questions about the role, the team or the next steps",
    difficulty: "easy",
    targetWords: { min: 15, max: 90 },
  },
};

/**
 * Which parts a screen of `count` questions covers. A recruiter never skips the
 * pitch, and salary is the part people most need reps on, so both come first
 * when the call is short.
 */
function screenParts(count: number): ScreenType[] {
  if (count <= 1) return ["pitch"];
  if (count === 2) return ["pitch", "salary"];
  if (count === 3) return ["pitch", "motivation", "salary"];
  if (count === 4) return ["pitch", "motivation", "experience", "salary"];
  if (count === 5) return ["pitch", "motivation", "experience", "salary", "logistics"];
  // Longer calls dig into experience more than once, before the money talk.
  const extra = Array.from({ length: count - 6 }, () => "experience" as const);
  return ["pitch", "motivation", "experience", ...extra, "salary", "logistics", "questions"];
}

function screenLoop({ count, keySkills, focusAreas, ctx }: LoopInputs): QuestionSlot[] {
  const skills = skillPool(ctx, focusAreas, keySkills, false);
  let experienceSeen = 0;
  return screenParts(count).map((part, i) => {
    const spec = SCREEN_PARTS[part];
    const targetSkill = part === "experience" ? skills[experienceSeen++ % Math.max(skills.length, 1)] : undefined;
    return {
      index: i + 1,
      stage: "screen",
      type: part,
      difficulty: spec.difficulty,
      targetSkill,
      intent: spec.intent,
      minutes: STAGE_MINUTES.screen,
      targetWords: spec.targetWords,
    };
  });
}

/* ── shared ───────────────────────────────────────────────────────────────── */

/**
 * The stage, time budget and length band for a question that didn't come from
 * a blueprint — one being practised again, as given. Same rules the slots use.
 */
export function slotDefaults(
  stage: string | undefined,
  type: string | undefined,
): { stage: InterviewStage; minutes: number; targetWords?: WordBand } {
  const part = SCREEN_TYPES.find((p) => p === type);
  if (part || stage === "screen") {
    return { stage: "screen", minutes: STAGE_MINUTES.screen, targetWords: part ? SCREEN_PARTS[part].targetWords : undefined };
  }
  if (stage === "closing") return { stage: "closing", minutes: STAGE_MINUTES.closing, targetWords: CLOSING_WORDS };
  if (stage === "warmup") return { stage: "warmup", minutes: STAGE_MINUTES.warmup, targetWords: STORY_WORDS };
  if (stage === "behavioral" || (!stage && type === "behavioral")) {
    return { stage: "behavioral", minutes: STAGE_MINUTES.behavioral, targetWords: STORY_WORDS };
  }
  if (stage === "situational" || type === "situational") return { stage: "situational", minutes: STAGE_MINUTES.situational };
  return { stage: "domain", minutes: STAGE_MINUTES.domain };
}

/** The blueprint as prompt text — one line per slot the model must fill. */
export function blueprintText(bp: InterviewBlueprint): string {
  return bp.slots
    .map(
      (s) =>
        `${s.index}. stage=${s.stage} | type=${s.type} | difficulty=${s.difficulty} | minutes=${s.minutes}` +
        `${s.targetSkill ? ` | probe=${s.targetSkill}` : ""} — ${s.intent}`,
    )
    .join("\n");
}

/**
 * Holds what the model wrote to the slot it was given. The model fills in the
 * words; the stage, type, difficulty and time budget are ours, and a model that
 * drifts on them (it does, at temperature 0.9) would otherwise silently change
 * the shape of the round and the rubric each answer is scored with.
 */
export function alignToSlot<T extends object>(question: T, slot: QuestionSlot | undefined): T {
  if (!slot) return question;
  return {
    ...question,
    stage: slot.stage,
    type: slot.type,
    difficulty: slot.difficulty,
    timeAllocationMinutes: slot.minutes,
    ...(slot.targetWords ? { targetWords: slot.targetWords } : {}),
    ...(slot.competency ? { competency: slot.competency, competencyLabel: slot.competencyLabel } : {}),
  };
}

/** Align a whole generated batch to the blueprint, slot by slot; extras are dropped. */
export function alignToBlueprint(questions: unknown, bp: InterviewBlueprint): unknown[] {
  if (!Array.isArray(questions)) return [];
  return questions
    .slice(0, bp.slots.length)
    .map((q, i) => (q && typeof q === "object" ? { ...alignToSlot(q as object, bp.slots[i]), id: i + 1 } : q));
}

/** Which stages a transcript actually covered — used in the final debrief. */
export function stageCoverage(
  bp: InterviewBlueprint,
  answered: Array<{ type?: string }>,
): Array<{ stage: InterviewStage; planned: number; answered: number }> {
  const stages: InterviewStage[] = ["warmup", "behavioral", "domain", "situational", "closing", "screen"];
  return stages
    .map((stage) => {
      const planned = bp.slots.filter((s) => s.stage === stage).length;
      const plannedTypes = new Set(bp.slots.filter((s) => s.stage === stage).map((s) => s.type));
      const answeredCount = answered.filter((a) => a.type && plannedTypes.has(a.type)).length;
      return { stage, planned, answered: answeredCount };
    })
    .filter((s) => s.planned > 0);
}

/**
 * How long an answer is, against its band. Deterministic on purpose: the
 * model is unreliable at counting, and "your pitch ran 2½ minutes" has to be
 * true to be worth saying.
 */
export interface LengthCheck {
  words: number;
  /** At ~150 words a minute, what this would take to say out loud. */
  spokenSeconds: number;
  target: WordBand;
  verdict: "short" | "ok" | "long";
}

export const SPOKEN_WORDS_PER_MINUTE = 150;

export function lengthCheck(answer: string, target: WordBand | undefined): LengthCheck | null {
  if (!target) return null;
  const words = answer.trim() ? answer.trim().split(/\s+/).length : 0;
  return {
    words,
    spokenSeconds: Math.round((words / SPOKEN_WORDS_PER_MINUTE) * 60),
    target,
    verdict: words < target.min ? "short" : words > target.max ? "long" : "ok",
  };
}

/** A stored question's band, if it carries a valid one. */
export function readWordBand(raw: unknown): WordBand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { min, max } = raw as { min?: unknown; max?: unknown };
  return typeof min === "number" && typeof max === "number" && min >= 0 && max > min ? { min, max } : undefined;
}
