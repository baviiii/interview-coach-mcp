/**
 * Every table, column and database function this server reads or writes.
 *
 * This server shares CareerCraft's database but not its migrations, so a column
 * the CareerCraft repo drops just starts failing here — and because most writes
 * are best-effort, quietly. That is how skill saving and goal saving broke in
 * May without anyone noticing. `npm run schema-check` probes each entry against
 * the live database (CI on every push, and daily), and a unit check makes sure
 * every `.from()` / `.rpc()` in src is listed here.
 *
 * When a tool starts using a new column, add it here.
 */
export const TABLES_USED: Record<string, readonly string[]> = {
  ai_recommendations: [
    "id", "user_id", "recommendation_type", "title", "description", "ai_reasoning",
    "confidence_score", "status", "created_at",
  ],
  interview_answers: [
    "session_id", "user_id", "question_id", "question_text", "question_type", "answer_text",
    "overall_score", "time_taken_seconds", "answered_at",
  ],
  interview_sessions: [
    "id", "user_id", "field", "seniority", "status", "questions", "question_count",
    "completed_at", "avg_score", "ai_insights", "created_at",
  ],
  job_applications: ["id", "user_id", "job_title", "company", "location", "job_description", "status"],
  job_fit_scores: ["application_id", "user_id", "score", "strengths", "gaps", "created_at"],
  learning_resources: ["id", "title", "resource_type", "difficulty", "provider", "duration_minutes", "skill_tags"],
  onboarding_runs: ["user_id", "ai_analysis", "status", "created_at"],
  profiles: ["id", "ai_persona", "target_job_titles", "current_job_title", "career_level"],
  resumes: ["user_id", "content"],
  score_history: ["user_id", "session_id", "overall_score", "recorded_at"],
  skill_tags: ["id", "name", "category"],
  user_certifications: [
    "id", "user_id", "name", "issuer", "issue_date", "expiry_date", "credential_id", "credential_url",
  ],
  user_milestones: ["id", "user_id"],
  user_patterns: [
    "id", "user_id", "total_sessions", "total_questions_answered", "current_streak_days",
    "longest_streak_days", "last_practice_date", "overall_trend", "strongest_question_type",
    "weakest_question_type", "updated_at",
  ],
  user_preferences: ["user_id", "job_role_type", "interview_types", "updated_at"],
  user_resources: ["user_id", "resource_id", "status", "progress_percent"],
  user_skills: [
    "user_id", "skill_id", "proficiency", "proficiency_level", "trend", "times_tested",
    "last_tested_at", "category", "updated_at",
  ],
};

/**
 * Database functions called with `.rpc()`, with the argument names the code
 * passes. The database finds a function by its name *and* argument names, so a
 * renamed argument breaks the call just like a dropped function.
 */
export const FUNCTIONS_USED: Record<string, readonly string[]> = {
  ensure_skill_tags: ["p_names", "p_categories"],
};
