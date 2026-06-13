/** Shared domain types used across context assembly and tools. */

export interface SkillSnapshot {
  skillId?: string;
  name: string;
  category?: string;
  proficiency: number; // 0-100
  trend: "improving" | "stable" | "declining";
  timesTested?: number;
  /** ISO timestamp of the last drill/interview touch — drives spaced repetition. */
  lastTestedAt?: string | null;
}

export type CertificationStatus = "active" | "expiring_soon" | "expired";

export interface CertificationSnapshot {
  id?: string;
  name: string;
  issuer?: string;
  issueDate?: string | null;
  expiryDate?: string | null;
  status: CertificationStatus;
  credentialUrl?: string | null;
  /** Curated catalog entry this cert matched, if recognized. */
  catalogId?: string;
  /** Skills this certification vouches for (from the catalog). */
  skills?: string[];
}

export interface CareerGoal {
  targetField?: string;
  targetRole?: string;
  seniority?: string;
  jobRoleType?: string;
  interviewTypes?: string[];
}

export interface ApplicationsSnapshot {
  total: number;
  active: number;
  interviews: number;
  offers: number;
  recentTitles: string[];
}

export interface JobContext {
  jobId: string;
  title: string;
  company: string;
  location?: string;
  description?: string;
  fitScore?: number;
  gaps?: string[];
  strengths?: string[];
}

export interface LearnerContext {
  userId: string;
  /** AI-derived persona from onboarding (profiles.ai_persona). */
  persona?: Record<string, unknown> | null;
  targetField?: string;
  targetSeniority?: string;
  skills: SkillSnapshot[];
  weakSkills: SkillSnapshot[];
  strongSkills: SkillSnapshot[];
  recentOverallScores: number[];
  /** Real certifications the learner holds (user_certifications). */
  certifications: CertificationSnapshot[];
  /** Stated career goal (user_preferences + latest career_goal recommendation). */
  goal?: CareerGoal | null;
  /** First ~1500 chars of the latest resume — career-history signal. */
  resumeSummary?: string | null;
  /** Job-search pipeline signal (job_applications). */
  applications?: ApplicationsSnapshot | null;
  milestonesAchieved?: number;
  patterns?: {
    overallTrend?: string;
    strongestQuestionType?: string;
    weakestQuestionType?: string;
    currentStreakDays?: number;
    totalSessions?: number;
  } | null;
  job?: JobContext | null;
}
