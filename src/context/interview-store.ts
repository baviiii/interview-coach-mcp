/**
 * The interview data this server writes beyond the original session/answer
 * rows: what kind of round a session was, the full evaluation behind each
 * answer, and the learner's story library.
 *
 * Every write here is best-effort and separate from the write it decorates.
 * The columns and table arrive with CareerCraft migrations, and this server
 * has deployed ahead of those before; an interview must never fail because a
 * tag couldn't be saved. A failure is logged, so it isn't silent either.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { competencyLabel } from "../domain/competencies.js";
import type { StorySnapshot } from "../types.js";

type Db = SupabaseClient;

function warn(what: string, error: { code?: string; message?: string } | null | undefined): void {
  if (error) console.warn(`[store] ${what} not saved (${error.code ?? "no code"}): ${error.message ?? ""}`);
}

/**
 * Tag a session: round type, public-sector framework, and the tracker job it
 * was practice for. One write first; if that fails (a column missing), each
 * field on its own, so one missing column doesn't lose the others.
 */
export async function tagSession(
  db: Db,
  sessionId: string,
  tags: { roundType: string; framework?: string | null; jobApplicationId?: string | null },
): Promise<void> {
  const fields: Record<string, unknown> = { round_type: tags.roundType };
  if (tags.framework) fields.framework = tags.framework;
  if (tags.jobApplicationId) fields.job_application_id = tags.jobApplicationId;
  try {
    const { error } = await db.from("interview_sessions").update(fields).eq("id", sessionId);
    if (!error) return;
    for (const [key, value] of Object.entries(fields)) {
      const { error: one } = await db.from("interview_sessions").update({ [key]: value }).eq("id", sessionId);
      warn(`interview_sessions.${key}`, one);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * The job id, if it's one of this learner's own tracker jobs. A session is
 * only ever tagged with their own job: the foreign key alone would accept any
 * existing job id, leaving a session pointing at someone else's application.
 */
export async function ownedJobId(db: Db, userId: string, jobId: string | undefined): Promise<string | null> {
  if (!jobId) return null;
  try {
    const { data, error } = await db
      .from("job_applications")
      .select("id")
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    return !error && data ? jobId : null;
  } catch {
    return null;
  }
}

/** The evaluation behind an answer, so progress can be read back (STAR habits, retries). */
export async function saveAnswerDetail(
  db: Db,
  answerId: string,
  detail: { evaluation: unknown; attempt: number },
): Promise<void> {
  try {
    const { error } = await db
      .from("interview_answers")
      .update({ evaluation: detail.evaluation, attempt: detail.attempt })
      .eq("id", answerId);
    warn("interview_answers.evaluation", error);
  } catch {
    /* best-effort */
  }
}

/* ── story library ──────────────────────────────────────────────────────── */

export async function readStories(db: Db, userId: string): Promise<StorySnapshot[]> {
  try {
    const { data, error } = await db
      .from("interview_stories")
      .select("competency, title, best_score, times_practised")
      .eq("user_id", userId)
      .limit(60);
    if (error) return [];
    return (data ?? []).map((r: Record<string, unknown>) => ({
      competency: String(r.competency),
      title: String(r.title ?? ""),
      bestScore: typeof r.best_score === "number" ? r.best_score : r.best_score == null ? null : Number(r.best_score),
      timesPractised: Number(r.times_practised ?? 0),
    }));
  } catch {
    return [];
  }
}

export interface StoryOutcome {
  competency: string;
  label: string;
  title: string;
  /** new: first story for this competency; improved: this beat the best; kept: the best still stands. */
  outcome: "new" | "improved" | "kept";
  bestScore: number;
  /** The best before this answer, when there was one. */
  previousBest: number | null;
}

/**
 * Keep the learner's best story per competency. A better (or equal) answer
 * replaces the stored one; a weaker one only counts as practice, so the
 * library always holds the version worth reusing.
 */
export async function saveStory(
  db: Db,
  userId: string,
  story: {
    competency: string;
    title: string;
    answer: string;
    score: number;
    star: unknown;
    sessionId: string | null;
    seniority?: string;
  },
): Promise<StoryOutcome | null> {
  const label = competencyLabel(story.competency, story.seniority);
  const now = new Date().toISOString();
  try {
    const { data: existing, error: readError } = await db
      .from("interview_stories")
      .select("id, title, best_score, times_practised")
      .eq("user_id", userId)
      .eq("competency", story.competency)
      .maybeSingle();
    if (readError) {
      warn("interview_stories (read)", readError);
      return null;
    }

    if (!existing) {
      const { error } = await db.from("interview_stories").insert({
        user_id: userId,
        competency: story.competency,
        title: story.title,
        best_answer: story.answer,
        best_score: story.score,
        star: story.star ?? null,
        source_session_id: story.sessionId,
        times_practised: 1,
        last_practised_at: now,
      });
      warn("interview_stories (insert)", error);
      return error ? null : { competency: story.competency, label, title: story.title, outcome: "new", bestScore: story.score, previousBest: null };
    }

    const previousBest = existing.best_score == null ? null : Number(existing.best_score);
    const better = previousBest === null || story.score >= previousBest;
    const update: Record<string, unknown> = {
      times_practised: Number(existing.times_practised ?? 0) + 1,
      last_practised_at: now,
      updated_at: now,
    };
    if (better) {
      Object.assign(update, {
        title: story.title,
        best_answer: story.answer,
        best_score: story.score,
        star: story.star ?? null,
        source_session_id: story.sessionId,
      });
    }
    const { error } = await db.from("interview_stories").update(update).eq("id", existing.id);
    warn("interview_stories (update)", error);
    if (error) return null;
    return {
      competency: story.competency,
      label,
      title: better ? story.title : String(existing.title ?? ""),
      outcome: better ? (previousBest === null ? "new" : "improved") : "kept",
      bestScore: better ? story.score : previousBest!,
      previousBest,
    };
  } catch {
    return null;
  }
}

/** Their stored best stories, full text — what the selection-criteria drafter writes from. */
export async function readStoryTexts(
  db: Db,
  userId: string,
): Promise<Array<{ competency: string; title: string; answer: string; score: number | null }>> {
  try {
    const { data, error } = await db
      .from("interview_stories")
      .select("competency, title, best_answer, best_score")
      .eq("user_id", userId)
      .order("best_score", { ascending: false })
      .limit(20);
    if (error) return [];
    return (data ?? []).map((r: Record<string, unknown>) => ({
      competency: String(r.competency),
      title: String(r.title ?? ""),
      answer: String(r.best_answer ?? ""),
      score: r.best_score == null ? null : Number(r.best_score),
    }));
  } catch {
    return [];
  }
}

/* ── practice signals (for the coach's read of their patterns) ─────────── */

const STAR_PARTS = ["situation", "task", "action", "result", "reflection"] as const;

export interface PracticeSignals {
  /** Finished sessions, newest first (up to 20). */
  sessions: Array<{ id: string; roundType: string | null; score: number | null; completedAt: string | null }>;
  /** How their last story answers (up to 10) covered each STAR(R) part. */
  star: {
    stories: number;
    parts: Array<{ part: (typeof STAR_PARTS)[number]; present: number; thin: number; missing: number }>;
    /** "I" vs "we" across those stories. */
    i: number;
    we: number;
  };
  /** Answer length against its band, across their last 30 scored answers. */
  length: { short: number; ok: number; long: number };
}

/**
 * What their practice shows beyond scores: the round types they've finished,
 * STAR habits and answer length, read the same way the site's STAR habits
 * panel reads them (the evaluation stored with each answer).
 */
export async function readPracticeSignals(db: Db, userId: string): Promise<PracticeSignals> {
  const empty: PracticeSignals = {
    sessions: [],
    star: { stories: 0, parts: [], i: 0, we: 0 },
    length: { short: 0, ok: 0, long: 0 },
  };
  try {
    const [sessionsRes, answersRes] = await Promise.all([
      db
        .from("interview_sessions")
        .select("id, round_type, avg_score, completed_at")
        .eq("user_id", userId)
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(20),
      db
        .from("interview_answers")
        .select("evaluation, answered_at")
        .eq("user_id", userId)
        .not("evaluation", "is", null)
        .order("answered_at", { ascending: false })
        .limit(30),
    ]);

    const sessions = (sessionsRes.data ?? []).map((r: Record<string, unknown>) => ({
      id: String(r.id),
      roundType: typeof r.round_type === "string" ? r.round_type : null,
      score: r.avg_score == null ? null : Number(r.avg_score),
      completedAt: typeof r.completed_at === "string" ? r.completed_at : null,
    }));

    const evaluations = (answersRes.data ?? []).map(
      (r: Record<string, unknown>) =>
        (r.evaluation ?? {}) as {
          starBreakdown?: Record<string, unknown> | null;
          ownership?: { i?: number; we?: number } | null;
          lengthCheck?: { verdict?: string } | null;
        },
    );
    const stories = evaluations.filter((e) => e.starBreakdown && typeof e.starBreakdown === "object").slice(0, 10);
    const parts = STAR_PARTS.map((part) => {
      const marks = stories.map((s) => s.starBreakdown![part]);
      return {
        part,
        present: marks.filter((m) => m === "present").length,
        thin: marks.filter((m) => m === "thin").length,
        missing: marks.filter((m) => m === "missing").length,
      };
    }).filter((p) => p.present + p.thin + p.missing > 0);
    const owned = stories.map((s) => s.ownership).filter((o): o is { i?: number; we?: number } => !!o);

    const verdicts = evaluations.map((e) => e.lengthCheck?.verdict);
    return {
      sessions,
      star: {
        stories: stories.length,
        parts,
        i: owned.reduce((n, o) => n + (Number(o.i) || 0), 0),
        we: owned.reduce((n, o) => n + (Number(o.we) || 0), 0),
      },
      length: {
        short: verdicts.filter((v) => v === "short").length,
        ok: verdicts.filter((v) => v === "ok").length,
        long: verdicts.filter((v) => v === "long").length,
      },
    };
  } catch {
    return empty;
  }
}
