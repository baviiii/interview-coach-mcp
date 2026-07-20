import type { SupabaseClient } from "@supabase/supabase-js";

import { bandToProficiency } from "./assemble.js";

/**
 * The personalization flywheel: every evaluated answer, drill result, and
 * earned certification updates the learner's skill matrix, which biases the
 * next questions, plans and recommendations. All writes are best-effort and
 * tolerate both user_skills shapes (skill_name TEXT vs skill_id FK).
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

/** Best-effort writes stay best-effort, but never silent: one warn per miss. */
function warnDb(op: string, detail: unknown): void {
  const msg = (detail as { message?: string })?.message ?? String(detail);
  console.warn(`[persist] ${op} failed (change not saved): ${msg}`);
}

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

/** Apply one skill signal to user_skills. Best-effort: returns what happened. */
export async function persistSkillSignal(
  db: SupabaseClient,
  userId: string,
  signal: SkillSignal,
): Promise<SkillPersistResult> {
  const none: SkillPersistResult = { persisted: false, previousProficiency: null, newProficiency: null };
  const name = signal.name?.trim();
  if (!name) return none;

  let rows: any[] = [];
  try {
    const { data, error } = await db.from("user_skills").select("*").eq("user_id", userId);
    if (error) {
      warnDb("user_skills read", error);
      return none;
    }
    rows = data ?? [];
  } catch (e) {
    warnDb("user_skills read", e);
    return none;
  }

  // Match by skill_name when the column exists; the FK shape (skill_id only)
  // can't be matched by name without skill_tags writes, which RLS forbids.
  const lower = name.toLowerCase();
  const existing = rows.find((r) => typeof r.skill_name === "string" && r.skill_name.toLowerCase() === lower);

  const prev: number = existing
    ? typeof existing.proficiency_level === "number"
      ? existing.proficiency_level
      : bandToProficiency(existing.proficiency)
    : 0;

  let next = prev;
  if (typeof signal.demonstrated === "number") next = blend(prev, Math.max(0, Math.min(100, signal.demonstrated)));
  if (typeof signal.drillScore === "number") next = nudge(next, signal.drillScore);
  if (typeof signal.floor === "number") next = Math.max(next, Math.min(100, signal.floor));
  if (existing && next === prev && typeof signal.drillScore !== "number") {
    // Still record the touch (last_tested_at / times_tested) below.
  }

  const richColumns = existing
    ? {
        has: (col: string) => col in existing,
      }
    : // Fresh table — write the profile shape (skill_name) plus the tracking
      // columns; if the live table rejects unknown columns we retry minimal.
      { has: (_col: string) => true };

  const nowIso = new Date().toISOString();
  const base: Record<string, unknown> = { user_id: userId, skill_name: name };
  if (richColumns.has("category") && signal.category) base["category"] = signal.category;
  if (richColumns.has("proficiency")) base["proficiency"] = proficiencyToBand(next);
  if (richColumns.has("proficiency_level")) base["proficiency_level"] = next;
  if (richColumns.has("trend")) base["trend"] = trendFor(prev, next, existing?.trend);
  if (richColumns.has("last_tested_at")) base["last_tested_at"] = nowIso;
  if (richColumns.has("times_tested")) base["times_tested"] = (existing?.times_tested ?? 0) + 1;
  if (richColumns.has("updated_at")) base["updated_at"] = nowIso;

  try {
    if (existing) {
      const { error } = await db.from("user_skills").update(base).eq("id", existing.id);
      if (error) {
        warnDb(`user_skills update (${name})`, error);
        return { ...none, previousProficiency: prev };
      }
    } else {
      let { error } = await db.from("user_skills").insert(base);
      if (error) {
        // Minimal profile-shape fallback (the fix-migration table).
        const minimal = {
          user_id: userId,
          skill_name: name,
          proficiency: proficiencyToBand(next),
          ...(signal.category ? { category: signal.category } : {}),
        };
        ({ error } = await db.from("user_skills").insert(minimal));
        if (error) {
          warnDb(`user_skills insert (${name})`, error);
          return none;
        }
      }
    }
    return { persisted: true, previousProficiency: existing ? prev : null, newProficiency: next };
  } catch (e) {
    warnDb(`user_skills write (${name})`, e);
    return none;
  }
}

/** Persist several signals; returns how many landed. */
export async function persistSkillSignals(
  db: SupabaseClient,
  userId: string,
  signals: SkillSignal[],
): Promise<number> {
  let count = 0;
  for (const s of signals) {
    const r = await persistSkillSignal(db, userId, s);
    if (r.persisted) count += 1;
  }
  return count;
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
