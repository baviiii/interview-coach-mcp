/**
 * The learner's own resources: what they saved, started and finished.
 *
 * A row is either a catalogue resource (resource_id) or a link the coach found
 * or suggested (url + title). The catalogue (learning_resources) is empty in
 * production, so links are what people actually track. The columns for links
 * come from CareerCraft migration
 * 20261031000000_coach_saved_results_and_resource_links.sql.
 *
 * Finishing a resource is learning evidence: it credits a skill, once. Saying
 * "done" again later doesn't credit it again.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ResourceSnapshot } from "../types.js";
import { persistSkillSignals } from "./persist.js";
import { warnDb } from "./warn.js";

type Db = SupabaseClient;
export type ResourceStatus = ResourceSnapshot["status"];

/** Completing a resource counts like a decent practice session. */
const COMPLETION_DRILL_SCORE = 6.5;

/** A link as it's stored and compared: trimmed, without a trailing slash or #fragment. */
export function normaliseUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  return s.replace(/#.*$/, "").replace(/\/+$/, "") || null;
}

/** Finished (newest first, up to 10) and in-progress or saved resources, for the learner context. */
export async function readResources(db: Db, userId: string): Promise<ResourceSnapshot[]> {
  try {
    const { data, error } = await db
      .from("user_resources")
      .select("resource_id, url, title, status, skill, user_rating, completed_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(60);
    if (error) return [];
    const rows: ResourceSnapshot[] = (data ?? []).map((r: Record<string, unknown>) => ({
      title: String(r.title ?? "a saved resource"),
      url: typeof r.url === "string" ? r.url : undefined,
      resourceId: typeof r.resource_id === "string" ? r.resource_id : undefined,
      status: r.status === "completed" || r.status === "in_progress" ? r.status : "saved",
      skill: typeof r.skill === "string" ? r.skill : undefined,
      rating: typeof r.user_rating === "number" ? r.user_rating : null,
      completedAt: typeof r.completed_at === "string" ? r.completed_at : null,
    }));
    const finished = rows
      .filter((r) => r.status === "completed")
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      .slice(0, 10);
    return [...rows.filter((r) => r.status !== "completed"), ...finished];
  } catch {
    return [];
  }
}

/** Links the learner has finished, normalised, so recommendations can leave them out. */
export function finishedUrls(resources: ResourceSnapshot[] | undefined): Set<string> {
  return new Set(
    (resources ?? [])
      .filter((r) => r.status === "completed")
      .map((r) => normaliseUrl(r.url))
      .filter((u): u is string => u !== null),
  );
}

/** The learner's status for a link, if they've saved it. */
export function statusFor(resources: ResourceSnapshot[] | undefined, url: string | null | undefined): ResourceStatus | undefined {
  const key = normaliseUrl(url);
  if (!key) return undefined;
  return (resources ?? []).find((r) => normaliseUrl(r.url) === key)?.status;
}

export interface TrackArgs {
  resourceId?: string;
  url?: string;
  title?: string;
  provider?: string;
  skill?: string;
  status: ResourceStatus;
  progressPercent?: number;
  rating?: number;
  notes?: string;
}

export interface TrackOutcome {
  persisted: boolean;
  previousStatus: ResourceStatus | null;
  skillsCredited: string[];
}

/**
 * Saves the learner's status on a resource, and credits skills the first time
 * it's finished: the catalogue row's skill tags, or the link's own skill.
 */
export async function trackResource(db: Db, userId: string, args: TrackArgs): Promise<TrackOutcome> {
  const url = normaliseUrl(args.url);
  const key = args.resourceId ? { column: "resource_id", value: args.resourceId } : { column: "url", value: url };
  const nowIso = new Date().toISOString();

  let previousStatus: ResourceStatus | null = null;
  try {
    const { data } = await db
      .from("user_resources")
      .select("status")
      .eq("user_id", userId)
      .eq(key.column, key.value)
      .maybeSingle();
    const s = (data as { status?: unknown } | null)?.status;
    previousStatus = s === "completed" || s === "in_progress" || s === "saved" ? s : null;
  } catch {
    /* treated as new */
  }

  let persisted = false;
  try {
    const { error } = await db.from("user_resources").upsert(
      {
        user_id: userId,
        ...(args.resourceId ? { resource_id: args.resourceId } : { url }),
        ...(args.title ? { title: args.title.slice(0, 300) } : {}),
        ...(args.provider ? { provider: args.provider.slice(0, 120) } : {}),
        ...(args.skill ? { skill: args.skill.slice(0, 100) } : {}),
        status: args.status,
        progress_percent:
          args.progressPercent ?? (args.status === "completed" ? 100 : args.status === "in_progress" ? 10 : 0),
        ...(args.rating ? { user_rating: args.rating } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
        ...(args.status === "in_progress" ? { started_at: nowIso } : {}),
        ...(args.status === "completed" ? { completed_at: nowIso } : {}),
      },
      { onConflict: args.resourceId ? "user_id,resource_id" : "user_id,url" },
    );
    if (error) warnDb("user_resources upsert", error);
    persisted = !error;
  } catch (e) {
    warnDb("user_resources upsert", e);
  }

  const skillsCredited = creditsSkill(previousStatus, args.status, persisted) ? await creditSkills(db, userId, args) : [];
  return { persisted, previousStatus, skillsCredited };
}

/** Finishing counts once: only the save that moves a resource to completed credits a skill. */
export function creditsSkill(previous: ResourceStatus | null, next: ResourceStatus, persisted: boolean): boolean {
  return persisted && next === "completed" && previous !== "completed";
}

async function creditSkills(db: Db, userId: string, args: TrackArgs): Promise<string[]> {
  try {
    let signals: Array<{ name: string; category?: string; drillScore: number }> = [];
    if (args.resourceId) {
      const { data: resource } = await db
        .from("learning_resources")
        .select("skill_tags")
        .eq("id", args.resourceId)
        .maybeSingle();
      const tagIds: string[] = Array.isArray(resource?.skill_tags) ? resource!.skill_tags : [];
      if (tagIds.length > 0) {
        const { data: tags } = await db.from("skill_tags").select("name, category").in("id", tagIds);
        signals = (tags ?? []).map((t: { name: string; category?: string }) => ({
          name: t.name,
          category: t.category,
          drillScore: COMPLETION_DRILL_SCORE,
        }));
      }
    }
    if (signals.length === 0 && args.skill?.trim()) {
      signals = [{ name: args.skill.trim(), drillScore: COMPLETION_DRILL_SCORE }];
    }
    if (signals.length === 0) return [];
    await persistSkillSignals(db, userId, signals);
    return signals.map((s) => s.name);
  } catch {
    return [];
  }
}
