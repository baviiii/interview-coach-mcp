import type { SupabaseClient } from "@supabase/supabase-js";

import { skillLevel } from "./assemble.js";
import { warnDb } from "./warn.js";

/**
 * The personalization flywheel: every evaluated answer, drill result, and
 * earned certification updates the learner's skill matrix, which biases the
 * next questions, plans and recommendations.
 *
 * user_skills rows are keyed by skill_id into the shared skill_tags dictionary
 * (CareerCraft's May canonicalisation dropped the old free-text skill_name).
 * Names become ids through the ensure_skill_tags database function, which adds
 * a new name to the dictionary safely — users can't write skill_tags directly.
 * Writing skill_name kept failing after that migration, so for months no answer
 * updated anyone's skills.
 */

export interface SkillSignal {
  name: string;
  category?: string;
  /** Absolute evidence of level (0–100), e.g. from an answer evaluation or a cert. */
  demonstrated?: number;
  /** Relative drill result (0–10) nudging the current level. */
  drillScore?: number;
  /** Never lower an existing proficiency below this (e.g. a cert sets a floor). */
  floor?: number;
}

export interface SkillPersistResult {
  persisted: boolean;
  previousProficiency: number | null;
  newProficiency: number | null;
}

/** What user_skills.category accepts (a CHECK constraint); anything else is left unset. */
const SKILL_CATEGORIES = ["technical", "behavioral", "leadership", "domain", "language"] as const;

export function normalizeSkillCategory(category: string | undefined): string | undefined {
  const c = category?.trim().toLowerCase();
  if (!c) return undefined;
  if ((SKILL_CATEGORIES as readonly string[]).includes(c)) return c;
  if (/behaviou?r|soft|communicat|interpersonal|teamwork/.test(c)) return "behavioral";
  if (/lead|manag/.test(c)) return "leadership";
  if (/tech|tool|software|hard/.test(c)) return "technical";
  return "domain";
}

/** How a name is matched to a dictionary entry: trimmed, single-spaced, case-insensitive. */
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();

function proficiencyToBand(p: number): string {
  if (p >= 85) return "expert";
  if (p >= 70) return "advanced";
  if (p >= 45) return "intermediate";
  return "beginner";
}

function blend(current: number, demonstrated: number): number {
  // Evidence moves you 35% of the way toward what you just demonstrated.
  return Math.round(current + (demonstrated - current) * 0.35);
}

function nudge(current: number, drillScore: number): number {
  let delta = (Math.max(0, Math.min(10, drillScore)) - 5) * 1.2;
  if (delta > 0 && current >= 80) delta *= 0.5;
  return Math.round(Math.max(0, Math.min(100, current + delta)));
}

function trendFor(prev: number, next: number, prevTrend?: string): string {
  if (next > prev + 1) return "improving";
  if (next < prev - 1) return "declining";
  return prevTrend ?? "stable";
}

/** Skill names → skill_tags ids (keyed by nameKey), adding any the dictionary doesn't have yet. */
export async function resolveSkillIds(
  db: SupabaseClient,
  signals: Array<{ name: string; category?: string }>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (signals.length === 0) return ids;
  try {
    const { data, error } = await db.rpc("ensure_skill_tags", {
      p_names: signals.map((s) => s.name),
      p_categories: signals.map((s) => normalizeSkillCategory(s.category) ?? null),
    });
    if (error) {
      warnDb("ensure_skill_tags", error);
      return ids;
    }
    for (const row of (data ?? []) as Array<{ requested: string; id: string }>) {
      ids.set(nameKey(row.requested), row.id);
    }
  } catch (e) {
    warnDb("ensure_skill_tags", e);
  }
  return ids;
}

/** The next level for one signal, from the current one. */
export function nextLevel(prev: number, signal: SkillSignal): number {
  let next = prev;
  if (typeof signal.demonstrated === "number") next = blend(prev, Math.max(0, Math.min(100, signal.demonstrated)));
  if (typeof signal.drillScore === "number") next = nudge(next, signal.drillScore);
  if (typeof signal.floor === "number") next = Math.max(next, Math.min(100, signal.floor));
  return next;
}

interface ExistingSkillRow {
  skill_id: string;
  proficiency?: string | null;
  proficiency_level?: number | null;
  trend?: string | null;
  times_tested?: number | null;
}

/**
 * Apply several signals in one round trip each way: resolve the names, read the
 * current rows, upsert the new levels on (user_id, skill_id). Signals naming the
 * same skill are applied in order. Returns one result per input signal.
 */
async function applySkillSignals(
  db: SupabaseClient,
  userId: string,
  signals: SkillSignal[],
): Promise<SkillPersistResult[]> {
  const none: SkillPersistResult = { persisted: false, previousProficiency: null, newProficiency: null };
  const valid = signals.map((s) => ({ ...s, name: s.name?.replace(/\s+/g, " ").trim() ?? "" }));
  const named = valid.filter((s) => s.name);
  if (named.length === 0) return signals.map(() => none);

  const ids = await resolveSkillIds(db, named);
  if (ids.size === 0) return signals.map(() => none);

  const existing = new Map<string, ExistingSkillRow>();
  try {
    const { data, error } = await db
      .from("user_skills")
      .select("skill_id, proficiency, proficiency_level, trend, times_tested")
      .eq("user_id", userId)
      .in("skill_id", [...new Set(ids.values())]);
    if (error) {
      warnDb("user_skills read", error);
      return signals.map(() => none);
    }
    for (const row of (data ?? []) as ExistingSkillRow[]) existing.set(row.skill_id, row);
  } catch (e) {
    warnDb("user_skills read", e);
    return signals.map(() => none);
  }

  const nowIso = new Date().toISOString();
  const rows = new Map<string, Record<string, unknown>>();
  const results = valid.map((signal): SkillPersistResult => {
    const skillId = signal.name ? ids.get(nameKey(signal.name)) : undefined;
    if (!skillId) return none;
    const current = existing.get(skillId);
    const prev = current ? skillLevel(current) : 0;
    const next = nextLevel(prev, signal);
    const timesTested = (current?.times_tested ?? 0) + 1;
    const category = normalizeSkillCategory(signal.category);
    // Later signals for the same skill build on the earlier ones in this batch.
    existing.set(skillId, { skill_id: skillId, proficiency_level: next, trend: current?.trend, times_tested: timesTested });
    rows.set(skillId, {
      user_id: userId,
      skill_id: skillId,
      proficiency_level: next,
      proficiency: proficiencyToBand(next),
      trend: trendFor(prev, next, current?.trend ?? undefined),
      last_tested_at: nowIso,
      times_tested: timesTested,
      updated_at: nowIso,
      ...(category ? { category } : {}),
    });
    return { persisted: true, previousProficiency: current ? prev : null, newProficiency: next };
  });

  try {
    const { error } = await db.from("user_skills").upsert([...rows.values()], { onConflict: "user_id,skill_id" });
    if (error) {
      warnDb("user_skills upsert", error);
      return signals.map(() => none);
    }
  } catch (e) {
    warnDb("user_skills upsert", e);
    return signals.map(() => none);
  }
  return results;
}

/** Apply one skill signal to user_skills. Best-effort: returns what happened. */
export async function persistSkillSignal(
  db: SupabaseClient,
  userId: string,
  signal: SkillSignal,
): Promise<SkillPersistResult> {
  const [result] = await applySkillSignals(db, userId, [signal]);
  return result!;
}

/** Persist several signals; returns how many landed. */
export async function persistSkillSignals(
  db: SupabaseClient,
  userId: string,
  signals: SkillSignal[],
): Promise<number> {
  const results = await applySkillSignals(db, userId, signals);
  return results.filter((r) => r.persisted).length;
}

/** Bump engagement counters on user_patterns (streaks, totals). Best-effort. */
export async function touchPracticePatterns(
  db: SupabaseClient,
  userId: string,
  opts: { sessionsDelta?: number; questionsDelta?: number } = {},
): Promise<boolean> {
  try {
    const { data } = await db
      .from("user_patterns")
      .select("id, total_sessions, total_questions_answered, current_streak_days, longest_streak_days, last_practice_date")
      .eq("user_id", userId)
      .maybeSingle();

    const today = new Date().toISOString().slice(0, 10);
    const last = data?.last_practice_date as string | undefined;
    let streak = data?.current_streak_days ?? 0;
    if (last !== today) {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      streak = last === yesterday ? streak + 1 : 1;
    }

    const patch = {
      user_id: userId,
      total_sessions: (data?.total_sessions ?? 0) + (opts.sessionsDelta ?? 0),
      total_questions_answered: (data?.total_questions_answered ?? 0) + (opts.questionsDelta ?? 0),
      current_streak_days: streak,
      longest_streak_days: Math.max(streak, data?.longest_streak_days ?? 0),
      last_practice_date: today,
      updated_at: new Date().toISOString(),
    };

    const { error } = data?.id
      ? await db.from("user_patterns").update(patch).eq("id", data.id)
      : await db.from("user_patterns").insert(patch);
    if (error) warnDb("user_patterns upsert", error);
    return !error;
  } catch (e) {
    warnDb("user_patterns upsert", e);
    return false;
  }
}
