/**
 * Interview session blueprint — the deterministic skeleton of a mock loop.
 *
 * Same division of labour as `domain/roadmap.ts`: WE decide the structure
 * (how many questions, of which type, at which difficulty, probing which of the
 * learner's real skills) and the model only fills each slot with content. The
 * previous approach — telling the model "~60% technical / 40% behavioral" in
 * prose — was routinely ignored, so a "full interview" could come back with no
 * behavioral question at all. Slots make that impossible.
 */

import { resolveCareerPath, getSeniorityModifier } from "./career-paths.js";
import type { Difficulty } from "./taxonomy.js";
import type { LearnerContext } from "../types.js";

export type InterviewStage = "warmup" | "behavioral" | "domain" | "situational" | "closing";

export interface QuestionSlot {
  /** 1-based position in the loop — also the question `id` the model must use. */
  index: number;
  stage: InterviewStage;
  /** One of taxonomy.QUESTION_TYPES. */
  type: string;
  difficulty: Difficulty;
  /** The learner's real skill this slot exists to probe, when we know one. */
  targetSkill?: string;
  /** What this slot screens for — goes into the prompt verbatim. */
  intent: string;
}

export interface InterviewBlueprint {
  field: string;
  seniority: string;
  /** False when the field didn't match a tuned career path — callers then omit
   *  generic key-skill guidance instead of asserting it. */
  fieldMatched: boolean;
  /** Empty when the field is unknown to us. */
  keySkills: string[];
  slots: QuestionSlot[];
  behavioralCount: number;
}

const STAGE_INTENT: Record<InterviewStage, string> = {
  warmup:
    "open the loop — get them talking about their actual background and why this role, using something concrete from their history",
  behavioral:
    "past behaviour under pressure — demand a specific real situation, their own actions, and a measurable result (STAR)",
  domain: "depth in the craft itself — probe whether they can reason, not just recall",
  situational: "judgment on a realistic dilemma this role hits — no single right answer, the reasoning is the signal",
  closing: "role fit and self-direction — what they'd want to know, and how they'd ramp in the first 90 days",
};

/** Difficulty ramp: warm up, build, peak near the end. Ceiling follows seniority. */
function rampDifficulty(position: number, total: number, seniority: string): Difficulty {
  const senior = /senior|lead|staff|principal|manager|director|head/i.test(seniority);
  const junior = /junior|entry|intern|graduate|associate|trainee/i.test(seniority);
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

/** Domain question types appropriate to the field. */
function domainTypes(fieldMatched: boolean, keySkills: string[]): string[] {
  if (!fieldMatched) return ["technical", "case_study"];
  const isSoftware = keySkills.some((s) => /data structures|algorithms/i.test(s));
  const isSystems = keySkills.some((s) => /system design|cloud/i.test(s));
  if (isSoftware) return ["technical", "coding", "system_design"];
  if (isSystems) return ["technical", "system_design", "case_study"];
  return ["technical", "case_study"];
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
}

export function interviewBlueprint(args: BlueprintArgs): InterviewBlueprint {
  const count = Math.min(Math.max(args.questionCount ?? 6, 1), 10);
  const seniority = args.seniority ?? "Mid-Level";
  const { path, matched } = resolveCareerPath(args.field);
  const mod = getSeniorityModifier(path, seniority);
  const keySkills = matched ? path.keySkills : [];
  const focusAreas = args.focusAreas ?? [];

  // Slot budget. Warmup/closing/situational are only affordable in a real loop;
  // short sets spend everything on behavioral + domain.
  const warmup = count >= 5 ? 1 : 0;
  const closing = count >= 6 ? 1 : 0;
  const situational = count >= 4 ? 1 : 0;
  const core = count - warmup - closing - situational;

  // The behavioral floor is the point of this file: a full loop ALWAYS carries
  // at least two behavioural questions, whatever the field's technical bias.
  const floor = count >= 4 ? 2 : 1;
  const weighted = Math.round(core * (path.behavioralWeight + mod.leadershipFocus * 0.15));
  let behavioral = Math.max(0, Math.min(core - 1, Math.max(floor, weighted)));
  if (core === 1 && /behavioral/i.test(args.ctx?.patterns?.weakestQuestionType ?? "")) behavioral = 1;
  const domain = core - behavioral;

  const behavioralSkills = skillPool(args.ctx, focusAreas, keySkills, true);
  const domainSkills = skillPool(args.ctx, focusAreas, keySkills, false);
  const types = domainTypes(matched, path.keySkills);

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
  const slots: QuestionSlot[] = stages.map((stage, i) => {
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

    return { index: i + 1, stage, type, difficulty, targetSkill, intent: STAGE_INTENT[stage] };
  });

  return {
    field: args.field,
    seniority,
    fieldMatched: matched,
    keySkills,
    slots,
    behavioralCount: slots.filter((s) => s.stage === "behavioral").length,
  };
}

/** The blueprint as prompt text — one line per slot the model must fill. */
export function blueprintText(bp: InterviewBlueprint): string {
  return bp.slots
    .map(
      (s) =>
        `${s.index}. stage=${s.stage} | type=${s.type} | difficulty=${s.difficulty}` +
        `${s.targetSkill ? ` | probe=${s.targetSkill}` : ""} — ${s.intent}`,
    )
    .join("\n");
}

/** Which stages a transcript actually covered — used in the final debrief. */
export function stageCoverage(
  bp: InterviewBlueprint,
  answered: Array<{ type?: string }>,
): Array<{ stage: InterviewStage; planned: number; answered: number }> {
  const stages: InterviewStage[] = ["warmup", "behavioral", "domain", "situational", "closing"];
  return stages
    .map((stage) => {
      const planned = bp.slots.filter((s) => s.stage === stage).length;
      const plannedTypes = new Set(bp.slots.filter((s) => s.stage === stage).map((s) => s.type));
      const answeredCount = answered.filter((a) => a.type && plannedTypes.has(a.type)).length;
      return { stage, planned, answered: answeredCount };
    })
    .filter((s) => s.planned > 0);
}
