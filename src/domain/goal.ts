/**
 * Which career goal a learner has, when it's recorded in more than one place.
 *
 * CareerCraft keeps the role someone is going for on their profile
 * (`profiles.target_job_titles`, written by getting-started, Settings and the
 * web app's "Going for" card). This server used to read only its own records —
 * `user_preferences.preferred_field` and an `ai_recommendations` "career_goal"
 * row — so a learner who onboarded as an electrician was coached on whatever
 * those older records said. The profile is now the source of truth, read in
 * the same order the web app reads it, and the older records are a fallback
 * for learners whose profile says nothing.
 */

import { STORED_LEVELS, seniorityBand, type StoredLevel } from "./field-profile.js";
import type { CareerGoal } from "../types.js";

export interface GoalSources {
  /** The `profiles` row, as stored — any column may be absent or oddly shaped. */
  profile?: Record<string, unknown> | null;
  prefs?: {
    preferred_field?: unknown;
    seniority_level?: unknown;
    job_role_type?: unknown;
    interview_types?: unknown;
  } | null;
  /** Title of the active career_goal recommendation, e.g. "Goal: Electrician". */
  goalTitle?: unknown;
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s || undefined;
};

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(clean).filter((s): s is string => s !== undefined) : [];

export function resolveGoal(s: GoalSources): CareerGoal | null {
  const p = s.profile ?? {};
  const persona = p.ai_persona && typeof p.ai_persona === "object" ? (p.ai_persona as Record<string, unknown>) : {};
  const targetTitle = list(p.target_job_titles)[0];
  const legacyRole = clean(typeof s.goalTitle === "string" ? s.goalTitle.replace(/^Goal:\s*/i, "") : undefined);

  // Exactly the web app's "Going for" order (useTargetRole), for role and field
  // alike, so the card and the coach never name different jobs. The older
  // records come last: user_preferences.preferred_field / seniority_level were
  // dropped from CareerCraft's schema, so they only exist on older deployments.
  const role =
    targetTitle ??
    clean(p.current_job_title) ??
    clean(persona.function) ??
    legacyRole ??
    clean(s.prefs?.preferred_field);

  const goal: CareerGoal = {
    targetRole: role,
    targetField: role,
    seniority: clean(p.career_level) ?? clean(s.prefs?.seniority_level),
    jobRoleType: clean(s.prefs?.job_role_type),
    interviewTypes: list(s.prefs?.interview_types),
  };
  if (goal.interviewTypes?.length === 0) goal.interviewTypes = undefined;

  const present = Object.values(goal).some((v) => v !== undefined);
  return present ? goal : null;
}

/**
 * A request that names a field explicitly is about that field — the web app's
 * "just this once" role, or an agent asking about a specific job — so it
 * replaces the saved role for that request, rather than research and prompts
 * blending two jobs. The level is the request's when it gives one, otherwise
 * the saved one: a request worded slightly differently ("Electrical" for a
 * saved "Electrician") must not quietly lose the learner's level.
 */
export function goalForRequest(
  goal: CareerGoal | null,
  opts: { field?: string; seniority?: string },
): CareerGoal | null {
  const field = clean(opts.field);
  const seniority = clean(opts.seniority) ?? goal?.seniority;
  if (!field) return goal || seniority ? { ...(goal ?? {}), seniority } : null;
  return { ...goal, targetField: field, targetRole: field, seniority };
}

/** Put `title` first in the target list, dropping a case-insensitive duplicate. Nothing else is removed. */
export function withTargetTitleFirst(existing: unknown, title: string): string[] {
  const t = clean(title);
  const rest = list(existing);
  if (!t) return rest;
  return [t, ...rest.filter((x) => x.toLowerCase() !== t.toLowerCase())];
}

/** Free-text seniority ("Senior", "Mid-Level", "Head of") as `profiles.career_level` stores it. */
export function toStoredLevel(seniority: string | undefined): StoredLevel | undefined {
  const s = clean(seniority)?.toLowerCase();
  if (!s) return undefined;
  if ((STORED_LEVELS as readonly string[]).includes(s)) return s as StoredLevel;
  const band = seniorityBand(s);
  return band === "junior" ? "entry" : band;
}
