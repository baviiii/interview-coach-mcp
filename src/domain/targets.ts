/**
 * Skill-target derivation — the cold-start fix for everything on the learning
 * side.
 *
 * The study plan, the drill scheduler and the learning pathway all used to
 * require a populated skill matrix, which only exists after a completed
 * interview. A brand-new learner therefore got a hard error from every one of
 * them ("No skills to plan around"), which reads as "the feature is broken".
 * This walks a fallback chain instead and always reports which rung it landed
 * on, so the caller can say so honestly.
 */

import { resolveCareerPath } from "./career-paths.js";
import type { FieldResearch } from "../adapters/research/port.js";
import type { LearnerContext } from "../types.js";

export interface SkillTarget {
  skill: string;
  /** Current proficiency, 0-100. 0 means "never tested". */
  from: number;
  to: number;
}

export type TargetSource = "requested" | "matrix" | "field" | "research" | "none";

export interface DerivedTargets {
  targets: SkillTarget[];
  source: TargetSource;
  /** Human-readable note when we fell back — surfaced in `_meta.degraded`. */
  note?: string;
}

const MAX_TARGETS = 4;

function withGoal(skill: string, from: number): SkillTarget {
  return { skill, from, to: Math.min(85, Math.max(from + 20, 50)) };
}

/** Credential/exam names researched for the field make poor *skill* targets. */
function looksLikeSkill(text: string): boolean {
  return text.length <= 60 && !/https?:\/\//.test(text);
}

export function deriveSkillTargets(args: {
  ctx: LearnerContext;
  /** Explicit skills from the caller — always wins. */
  skills?: string[];
  field?: string;
  research?: FieldResearch;
}): DerivedTargets {
  const { ctx } = args;

  if (args.skills?.length) {
    const targets = args.skills.slice(0, MAX_TARGETS).map((name) => {
      const known = ctx.skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
      return withGoal(name, known?.proficiency ?? 0);
    });
    return { targets, source: "requested" };
  }

  if (ctx.weakSkills.length > 0) {
    return {
      targets: ctx.weakSkills.slice(0, MAX_TARGETS).map((s) => withGoal(s.name, s.proficiency)),
      source: "matrix",
    };
  }

  // Nothing tested yet — but any tested skill still beats a guess.
  if (ctx.skills.length > 0) {
    return {
      targets: [...ctx.skills]
        .sort((a, b) => a.proficiency - b.proficiency)
        .slice(0, MAX_TARGETS)
        .map((s) => withGoal(s.name, s.proficiency)),
      source: "matrix",
    };
  }

  const field = args.field ?? ctx.goal?.targetField ?? ctx.targetField;
  const { path, matched } = resolveCareerPath(field);
  if (matched) {
    return {
      targets: path.keySkills.slice(0, MAX_TARGETS).map((s) => withGoal(s, 0)),
      source: "field",
      note: `No tested skills yet — targets derived from the core skills of ${field}. Finish a mock interview to replace these with measured ones.`,
    };
  }

  // Unknown field: lean on what the research actually surfaced about it.
  const researched = [...(args.research?.credentials ?? []), ...(args.research?.resources ?? [])]
    .map((s) => s.text.split(/[—:.\n]/)[0]!.trim())
    .filter(looksLikeSkill);
  if (researched.length > 0) {
    return {
      targets: [...new Set(researched)].slice(0, MAX_TARGETS).map((s) => withGoal(s, 0)),
      source: "research",
      note: "No tested skills yet — targets derived from what real sources say this field expects.",
    };
  }

  if (field) {
    return {
      targets: path.keySkills.slice(0, MAX_TARGETS).map((s) => withGoal(s, 0)),
      source: "field",
      note: `No tested skills yet and nothing field-specific found for "${field}" — starting from universal fundamentals. Finish a mock interview to make these real.`,
    };
  }

  return { targets: [], source: "none" };
}
