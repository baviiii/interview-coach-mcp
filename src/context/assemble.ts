import type { SupabaseClient } from "@supabase/supabase-js";

import { certStatus, matchCertification } from "../domain/certifications.js";
import { resolveGoal } from "../domain/goal.js";
import type {
  ApplicationsSnapshot,
  CareerGoal,
  CertificationSnapshot,
  LearnerContext,
  SkillSnapshot,
} from "../types.js";

/**
 * The context-normalizer. Reads the learner's real signals (RLS-scoped) and
 * folds them into one object every tool can condition on: skill matrix,
 * certifications, career goal, resume, application pipeline, score history,
 * behavioral patterns. Defensive throughout — any table may be empty (or have
 * a divergent schema) for a given deployment, and every read degrades to
 * "absent", never to a crash.
 */
export async function assembleLearnerContext(
  db: SupabaseClient,
  userId: string,
  opts: { jobId?: string; field?: string; seniority?: string } = {},
): Promise<LearnerContext> {
  // Demo/dev mode: no Supabase — return canned context so the whole server is
  // runnable and the UI can drive it end-to-end without credentials.
  if (process.env.AUTH_MODE === "dev") return demoContext(userId, opts);

  const [
    profileRes,
    skills,
    patternsRes,
    scoresRes,
    certs,
    goal,
    resumeSummary,
    applications,
    milestonesRes,
    recentQuestionThemes,
  ] = await Promise.all([
    db.from("profiles").select("ai_persona").eq("id", userId).maybeSingle(),
    readSkills(db, userId),
    db.from("user_patterns").select("*").eq("user_id", userId).maybeSingle(),
    db
      .from("score_history")
      .select("overall_score, recorded_at")
      .eq("user_id", userId)
      .order("recorded_at", { ascending: false })
      .limit(10),
    readCertifications(db, userId),
    readGoal(db, userId),
    readResumeSummary(db, userId),
    readApplications(db, userId),
    db.from("user_milestones").select("id", { count: "exact", head: true }).eq("user_id", userId),
    readRecentQuestions(db, userId),
  ]);

  const weakSkills = skills.filter((s) => s.proficiency < 60).slice(0, 5);
  const strongSkills = [...skills].filter((s) => s.proficiency >= 75).slice(0, 5);

  const recentOverallScores = (scoresRes.data ?? [])
    .map((r: any) => Number(r.overall_score))
    .filter((n: number) => !Number.isNaN(n))
    .reverse();

  const patterns = patternsRes.data
    ? {
        overallTrend: patternsRes.data.overall_trend,
        strongestQuestionType: patternsRes.data.strongest_question_type,
        weakestQuestionType: patternsRes.data.weakest_question_type,
        currentStreakDays: patternsRes.data.current_streak_days,
        totalSessions: patternsRes.data.total_sessions,
      }
    : null;

  const ctx: LearnerContext = {
    userId,
    persona: (profileRes.data as any)?.ai_persona ?? null,
    targetField: opts.field ?? goal?.targetField,
    targetSeniority: opts.seniority ?? goal?.seniority,
    skills,
    weakSkills,
    strongSkills,
    recentOverallScores,
    certifications: certs,
    goal,
    resumeSummary,
    applications,
    milestonesAchieved: milestonesRes.count ?? 0,
    recentQuestionThemes,
    patterns,
    job: null,
  };

  if (opts.jobId) {
    const { data: job } = await db
      .from("jobs_catalog")
      .select("id, title, company, location, full_description, description_snippet")
      .eq("id", opts.jobId)
      .maybeSingle();

    if (job) {
      const { data: fit } = await db
        .from("job_fit_scores")
        .select("score, strengths, gaps")
        .eq("jobs_catalog_id", opts.jobId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      ctx.job = {
        jobId: job.id,
        title: job.title,
        company: job.company,
        location: job.location ?? undefined,
        description: job.full_description ?? job.description_snippet ?? undefined,
        fitScore: fit?.score ?? undefined,
        gaps: toStringArray(fit?.gaps),
        strengths: toStringArray(fit?.strengths),
      };
    }
  }

  return ctx;
}

/**
 * user_skills has shipped in two shapes (interview-prep: skill_id FK +
 * proficiency_level INT; profile: skill_name TEXT + proficiency band). Read
 * whichever is live and normalize to SkillSnapshot.
 */
async function readSkills(db: SupabaseClient, userId: string): Promise<SkillSnapshot[]> {
  try {
    const { data, error } = await db
      .from("user_skills")
      .select("skill_id, proficiency_level, trend, times_tested, last_tested_at, skill_tags ( name, category )")
      .eq("user_id", userId)
      .order("proficiency_level", { ascending: true });
    if (!error && data && data.length > 0) {
      return data
        .filter((row: any) => row.skill_tags?.name)
        .map((row: any) => ({
          skillId: row.skill_id ?? undefined,
          name: row.skill_tags.name,
          category: row.skill_tags.category ?? undefined,
          proficiency: row.proficiency_level ?? 0,
          trend: (row.trend ?? "stable") as SkillSnapshot["trend"],
          timesTested: row.times_tested ?? 0,
          lastTestedAt: row.last_tested_at ?? null,
        }));
    }
    if (error) throw error;
  } catch {
    /* fall through to the flexible shape */
  }

  try {
    const { data } = await db.from("user_skills").select("*").eq("user_id", userId);
    return (data ?? [])
      .map((row: any): SkillSnapshot | null => {
        const name = row.skill_name ?? null;
        if (!name) return null;
        return {
          name,
          category: row.category ?? undefined,
          proficiency: row.proficiency_level ?? bandToProficiency(row.proficiency),
          trend: (row.trend ?? "stable") as SkillSnapshot["trend"],
          timesTested: row.times_tested ?? 0,
          lastTestedAt: row.last_tested_at ?? null,
        };
      })
      .filter((s): s is SkillSnapshot => s !== null)
      .sort((a, b) => a.proficiency - b.proficiency);
  } catch {
    return [];
  }
}

export function bandToProficiency(band: unknown): number {
  switch (typeof band === "string" ? band.toLowerCase() : "") {
    case "expert":
      return 90;
    case "advanced":
      return 75;
    case "intermediate":
      return 50;
    case "beginner":
      return 25;
    default:
      return 0;
  }
}

async function readCertifications(db: SupabaseClient, userId: string): Promise<CertificationSnapshot[]> {
  try {
    const { data } = await db
      .from("user_certifications")
      .select("id, name, issuer, issue_date, expiry_date, credential_url")
      .eq("user_id", userId)
      .order("issue_date", { ascending: false });
    return (data ?? []).map((row: any) => {
      const matched = matchCertification(row.name ?? "", row.issuer ?? undefined);
      return {
        id: row.id,
        name: row.name,
        issuer: row.issuer ?? undefined,
        issueDate: row.issue_date ?? null,
        expiryDate: row.expiry_date ?? null,
        status: certStatus(row.expiry_date),
        credentialUrl: row.credential_url ?? null,
        catalogId: matched?.id,
        skills: matched?.skills,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Career goal, from the learner's profile first (target job titles, level —
 * what getting-started and Settings write), then user_preferences and the
 * active "career_goal" recommendation for learners who never filled it in.
 * Precedence lives in `resolveGoal`; each read here is best-effort.
 */
async function readGoal(db: SupabaseClient, userId: string): Promise<CareerGoal | null> {
  const [profile, prefs, goalRow] = await Promise.all([
    db
      .from("profiles")
      .select("target_job_titles, current_job_title, career_level")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data }) => data, () => null),
    db
      .from("user_preferences")
      .select("preferred_field, seniority_level, job_role_type, interview_types")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data }) => data, () => null),
    db
      .from("ai_recommendations")
      .select("title")
      .eq("user_id", userId)
      .eq("recommendation_type", "career_goal")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => data, () => null),
  ]);
  return resolveGoal({ profile, prefs, goalTitle: goalRow?.title });
}

async function readResumeSummary(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("resumes")
      .select("content")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = data?.content;
    if (typeof content !== "string" || content.trim().length === 0) return null;
    return content.replace(/\s+/g, " ").trim().slice(0, 1500);
  } catch {
    return null;
  }
}

async function readApplications(db: SupabaseClient, userId: string): Promise<ApplicationsSnapshot | null> {
  try {
    const { data } = await db
      .from("job_applications")
      .select("status, job_title")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (!data || data.length === 0) return null;
    const by = (s: string) => data.filter((r: any) => r.status === s).length;
    return {
      total: data.length,
      active: by("applied") + by("interview"),
      interviews: by("interview"),
      offers: by("offer"),
      recentTitles: data.slice(0, 5).map((r: any) => r.job_title).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * What this learner has already been asked, across their recent sessions —
 * both answered questions and questions that were merely generated. Without
 * this, every new session is free to re-ask the same things, which is the main
 * reason mocks stop feeling like practice.
 */
async function readRecentQuestions(db: SupabaseClient, userId: string): Promise<string[]> {
  const themes: string[] = [];
  try {
    const { data } = await db
      .from("interview_answers")
      .select("question_text, answered_at")
      .eq("user_id", userId)
      .order("answered_at", { ascending: false })
      .limit(30);
    for (const row of data ?? []) {
      if (typeof (row as any).question_text === "string") themes.push((row as any).question_text);
    }
  } catch {
    /* best-effort */
  }
  try {
    const { data } = await db
      .from("interview_sessions")
      .select("questions, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);
    for (const row of data ?? []) {
      const qs = (row as any).questions;
      if (!Array.isArray(qs)) continue;
      for (const q of qs) {
        const text = typeof q === "string" ? q : (q as any)?.question;
        if (typeof text === "string") themes.push(text);
      }
    }
  } catch {
    /* best-effort */
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of themes) {
    const trimmed = t.replace(/\s+/g, " ").trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed);
    if (unique.length >= 25) break;
  }
  return unique;
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .map((x) => (typeof x === "string" ? x : (x as any)?.label ?? (x as any)?.text ?? JSON.stringify(x)))
    .filter(Boolean);
}

/** Canned learner context for demo/dev mode (no Supabase). */
function demoContext(userId: string, opts: { field?: string; seniority?: string }): LearnerContext {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const skills: SkillSnapshot[] = [
    { name: "System Design", category: "technical", proficiency: 41, trend: "improving", timesTested: 4, lastTestedAt: daysAgo(9) },
    { name: "Concurrency", category: "technical", proficiency: 55, trend: "stable", timesTested: 2, lastTestedAt: daysAgo(15) },
    { name: "Databases", category: "technical", proficiency: 63, trend: "improving", timesTested: 5, lastTestedAt: daysAgo(3) },
    { name: "Algorithms", category: "technical", proficiency: 71, trend: "declining", timesTested: 8, lastTestedAt: daysAgo(21) },
    { name: "Communication", category: "behavioral", proficiency: 82, trend: "improving", timesTested: 6, lastTestedAt: daysAgo(2) },
  ];
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  return {
    userId,
    persona: null,
    targetField: opts.field,
    targetSeniority: opts.seniority,
    skills,
    weakSkills: skills.filter((s) => s.proficiency < 60),
    strongSkills: skills.filter((s) => s.proficiency >= 75),
    recentOverallScores: [58, 61, 64, 68],
    certifications: [
      {
        name: "AWS Certified Solutions Architect – Associate",
        issuer: "Amazon Web Services",
        issueDate: "2023-08-15",
        expiryDate: inDays(45),
        status: "expiring_soon",
        catalogId: "aws-saa",
        skills: ["Cloud Services", "System Design", "Networking"],
      },
      {
        name: "CompTIA Security+",
        issuer: "CompTIA",
        issueDate: "2024-11-02",
        expiryDate: inDays(700),
        status: "active",
        catalogId: "security-plus",
        skills: ["Security", "Networking"],
      },
    ],
    goal: {
      targetField: opts.field ?? "Software Engineering",
      targetRole: "Senior Backend Engineer",
      seniority: opts.seniority ?? "Mid-Level",
    },
    resumeSummary:
      "Mid-level backend engineer, 4 years experience. Node.js/TypeScript services on AWS (ECS, Lambda, RDS). Led migration of a monolith to services at a fintech; on-call rotation; mentored two juniors.",
    applications: { total: 14, active: 5, interviews: 2, offers: 0, recentTitles: ["Senior Backend Engineer", "Platform Engineer"] },
    milestonesAchieved: 4,
    recentQuestionThemes: [
      "Walk me through the monolith-to-services migration you led — what broke first?",
      "Tell me about a time you disagreed with your tech lead.",
    ],
    patterns: {
      overallTrend: "improving",
      strongestQuestionType: "behavioral",
      weakestQuestionType: "system_design",
      currentStreakDays: 6,
      totalSessions: 12,
    },
    job: null,
  };
}
