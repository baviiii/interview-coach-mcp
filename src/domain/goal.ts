/**
 * Which career goal a learner has, when it's recorded in more than one place.
 *
 * CareerCraft keeps the role someone is going for on their profile
 * (`profiles.target_job_titles`, written by getting-started and Settings). This
 * server used to read only its own records — `user_preferences.preferred_field`
 * and an `ai_recommendations` "career_goal" row — so a learner who onboarded
 * as an electrician was coached on whatever those older records said. The
 * profile is now the source of truth, and the older records are a fallback for
 * learners who never filled it in.
 */

import type { CareerGoal } from "../types.js";

export interface GoalSources {
  profile?: {
    target_job_titles?: string[] | null;
    current_job_title?: string | null;
    career_level?: string | null;
  } | null;
  prefs?: {
    preferred_field?: string | null;
    seniority_level?: string | null;
    job_role_type?: string | null;
    interview_types?: unknown;
  } | null;
  /** Title of the active career_goal recommendation, e.g. "Goal: Electrician". */
  goalTitle?: string | null;
}

/** Cap shared with getting-started, which keeps at most six target titles. */
export const MAX_TARGET_TITLES = 6;

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s || undefined;
};

export function resolveGoal(s: GoalSources): CareerGoal | null {
  const targetTitle = (s.profile?.target_job_titles ?? []).map(clean).find(Boolean);
  // Where someone works now says what field they're in, not where they're headed,
  // so a current job title never becomes the goal itself.
  const currentJob = clean(s.profile?.current_job_title);
  const legacyRole = clean(s.goalTitle?.replace(/^Goal:\s*/i, ""));
  const types = s.prefs?.interview_types;

  const goal: CareerGoal = {
    targetRole: targetTitle ?? legacyRole,
    targetField: targetTitle ?? clean(s.prefs?.preferred_field) ?? currentJob ?? legacyRole,
    seniority: clean(s.profile?.career_level) ?? clean(s.prefs?.seniority_level),
    jobRoleType: clean(s.prefs?.job_role_type),
    interviewTypes: Array.isArray(types) ? types.map(clean).filter((t): t is string => !!t) : undefined,
  };

  const present = Object.values(goal).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined));
  return present ? goal : null;
}

/** Put `title` first in the target list, dropping a case-insensitive duplicate and keeping the cap. */
export function withTargetTitleFirst(existing: string[] | null | undefined, title: string): string[] {
  const t = clean(title);
  const rest = (existing ?? []).map(clean).filter((x): x is string => !!x);
  if (!t) return rest.slice(0, MAX_TARGET_TITLES);
  return [t, ...rest.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, MAX_TARGET_TITLES);
}
