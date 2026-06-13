import type { Difficulty } from "./taxonomy.js";
import type { LearnerContext } from "../types.js";

/**
 * Adaptive next-question selection — the "feels like a real interview" engine.
 * Branches difficulty off the running performance and steers toward the skill
 * the candidate is currently weakest at.
 */
export function nextDifficulty(recentScores: number[]): Difficulty {
  if (recentScores.length === 0) return "medium";
  const last = recentScores[recentScores.length - 1]!;
  const avg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
  const signal = last * 0.6 + avg * 0.4; // 0-10 scale

  if (signal >= 8.5) return "expert";
  if (signal >= 7) return "hard";
  if (signal >= 4.5) return "medium";
  return "easy";
}

/** Picks the skill to probe next: the lowest-proficiency relevant skill. */
export function focusSkill(ctx: LearnerContext): string | undefined {
  if (ctx.weakSkills.length > 0) return ctx.weakSkills[0]!.name;
  return undefined;
}

export function shouldOfferHint(recentScores: number[]): boolean {
  const last = recentScores[recentScores.length - 1];
  return last !== undefined && last < 4;
}
