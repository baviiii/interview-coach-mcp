/**
 * Spaced-repetition scheduling over the learner's skill matrix — SM-2 in
 * spirit, tuned for interview prep. Deterministic: the model writes the drill
 * content, this module decides WHAT to drill and WHEN, from real signals
 * (proficiency, last touch, trend).
 */

import type { SkillSnapshot } from "../types.js";

/** Days a skill "holds" before it needs another touch, by proficiency band. */
export function intervalDays(proficiency: number): number {
  if (proficiency >= 90) return 21;
  if (proficiency >= 75) return 14;
  if (proficiency >= 60) return 7;
  if (proficiency >= 40) return 3;
  return 1.5;
}

function daysSince(iso?: string | null, now = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/**
 * How urgently a skill needs review. Never-tested skills get a high constant
 * priority weighted by weakness; tested skills scale with overdueness, weakness
 * and a declining-trend penalty.
 */
export function reviewUrgency(s: SkillSnapshot, now = new Date()): number {
  const weakness = (100 - s.proficiency) / 100; // 0..1
  const age = daysSince(s.lastTestedAt, now);
  if (age === null) return 2 + weakness; // new skill: drill soon, weakest first
  const overdueness = age / intervalDays(s.proficiency);
  const trendPenalty = s.trend === "declining" ? 0.5 : 0;
  return overdueness * (1 + weakness) + trendPenalty;
}

export interface DrillPick {
  skill: SkillSnapshot;
  urgency: number;
  /** Human-readable reason — surfaced to the learner as "why this, why now". */
  whyNow: string;
}

/** Picks the next skill to drill: highest review urgency wins. */
export function pickDrillSkill(skills: SkillSnapshot[], now = new Date()): DrillPick | null {
  if (skills.length === 0) return null;
  let best: SkillSnapshot = skills[0]!;
  let bestU = -1;
  for (const s of skills) {
    const u = reviewUrgency(s, now);
    if (u > bestU) {
      best = s;
      bestU = u;
    }
  }
  const age = daysSince(best.lastTestedAt, now);
  const parts = [
    age === null ? "never drilled" : `last touched ${Math.round(age)}d ago (holds ~${intervalDays(best.proficiency)}d at this level)`,
    `proficiency ${best.proficiency}/100`,
  ];
  if (best.trend === "declining") parts.push("trend declining");
  return { skill: best, urgency: Math.round(bestU * 100) / 100, whyNow: parts.join(", ") };
}

/** Difficulty tier for a drill at this proficiency. */
export function drillDifficulty(proficiency: number): "easy" | "medium" | "hard" | "expert" {
  if (proficiency < 40) return "easy";
  if (proficiency < 60) return "medium";
  if (proficiency < 75) return "hard";
  return "expert";
}

/**
 * Proficiency update from a drill result (0–10). Centered at 5: a mediocre
 * performance barely moves the needle; strong/weak results move it more, with
 * diminishing gains near the top.
 */
export function proficiencyNudge(current: number, drillScore: number): number {
  const clampedScore = Math.max(0, Math.min(10, drillScore));
  let delta = (clampedScore - 5) * 1.2;
  if (delta > 0 && current >= 80) delta *= 0.5; // harder to climb near mastery
  const next = Math.round(Math.max(0, Math.min(100, current + delta)));
  return next;
}

/** When this skill is due again, given its (new) proficiency. */
export function nextReviewInDays(proficiency: number): number {
  return Math.round(intervalDays(proficiency) * 10) / 10;
}
