/**
 * Results the learner should see again: a career read, a roadmap, a
 * certification plan, a learning pathway, the weekly note, the coach's read of
 * their patterns.
 *
 * Each is saved whole (`payload`, the tool's response without `_meta`) against
 * the job it was for (`subject`), so the site can show the newest one instead
 * of asking the model again on every visit. Saving a new one expires the older
 * ones for the same job and level, so "active" always means "current".
 * `ai_reasoning` still gets the result as text, because explain_recommendation
 * reads it.
 *
 * Best-effort like every other write: a result the learner has just been shown
 * is never lost because it couldn't be saved, and a failure is logged. The
 * columns come from CareerCraft migration
 * 20261031000000_coach_saved_results_and_resource_links.sql.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { warnDb } from "./warn.js";

export type SavedResultType =
  | "career_guidance"
  | "roadmap"
  | "certification"
  | "certification_analysis"
  | "pathway"
  | "weekly_insight"
  | "pattern_analysis";

/**
 * How a subject (or level) is stored and looked up: trimmed, spaces collapsed,
 * lower-cased. The site normalises the same way before it reads
 * (careercraft-web `lib/savedResults.ts`), so "Registered Nurse " and
 * "registered nurse" find the same result.
 */
export function savedKey(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return s ? s.slice(0, 200) : null;
}

export interface SaveResultArgs {
  type: SavedResultType;
  title: string;
  description?: string | null;
  /** The job or field the result is for, as the request named it. */
  subject: string | null | undefined;
  /** Seniority, for results that change with it. */
  level?: string | null;
  payload: Record<string, unknown>;
}

/** Saves the result and expires the older ones it replaces. Returns the new row's id. */
export async function saveResult(db: SupabaseClient, userId: string, args: SaveResultArgs): Promise<string | null> {
  const subject = savedKey(args.subject);
  const level = savedKey(args.level);
  let id: string | null = null;
  try {
    const { data, error } = await db
      .from("ai_recommendations")
      .insert({
        user_id: userId,
        recommendation_type: args.type,
        title: args.title.slice(0, 200),
        description: args.description ?? null,
        ai_reasoning: JSON.stringify(args.payload).slice(0, 8000),
        payload: args.payload,
        subject,
        level,
        status: "active",
      })
      .select("id")
      .single();
    if (error) warnDb(`ai_recommendations ${args.type}`, error);
    id = (data as { id?: string } | null)?.id ?? null;
  } catch (e) {
    warnDb(`ai_recommendations ${args.type}`, e);
  }

  // Without a subject the site can't look the result up, so there's nothing to replace.
  if (id && subject) {
    try {
      let older = db
        .from("ai_recommendations")
        .update({ status: "expired", expires_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("recommendation_type", args.type)
        .eq("subject", subject)
        .eq("status", "active")
        .neq("id", id);
      older = level ? older.eq("level", level) : older.is("level", null);
      const { error } = await older;
      if (error) warnDb(`ai_recommendations ${args.type} (expire older)`, error);
    } catch (e) {
      warnDb(`ai_recommendations ${args.type} (expire older)`, e);
    }
  }
  return id;
}

/** The newest session the learner started, which a saved weekly note or pattern read is based on. */
export async function newestSessionId(
  db: SupabaseClient,
  userId: string,
  opts: { completedOnly?: boolean } = {},
): Promise<string | null> {
  try {
    let q = db.from("interview_sessions").select("id").eq("user_id", userId);
    if (opts.completedOnly) q = q.eq("status", "completed");
    const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}
