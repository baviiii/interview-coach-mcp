/**
 * Field profile — what hiring in one occupation actually looks like.
 *
 * This replaces a hand-written career-path table that only knew four tech
 * fields. Everything outside those four got generic weights, no key skills and
 * software question formats ("coding", "system_design"), which made this an IT
 * coach with a career-agnostic label. Now every field — nurse, electrician,
 * chef, software engineer — goes through the same path: the model describes the
 * field once, `parseFieldProfile` validates and clamps it, and the result is
 * cached (context/field-profile.ts). No occupation is named anywhere in code.
 *
 * What code still owns is genuinely field-independent: the closed set of
 * question formats the evaluator knows how to score, and how seniority shifts
 * weight from craft depth towards leadership.
 */

/** Domain question formats the rubric can score. The profile picks which apply. */
export const DOMAIN_FORMATS = ["technical", "practical", "case_study", "coding", "system_design"] as const;
export type DomainFormat = (typeof DOMAIN_FORMATS)[number];

/** Plain-language meaning of every question type, for prompts. */
export const FORMAT_GUIDE: Record<string, string> = {
  technical: "knowledge of the craft — explain how or why something in this field works",
  practical: "walk through actually doing a real task of this job, step by step, as they would on shift",
  case_study: "analyse a realistic scenario from this field and recommend a course of action",
  coding: "write or reason about code",
  system_design: "design a software system under stated constraints",
  behavioral: "a specific past situation, their own actions and a measurable result (STAR)",
  situational: "judgment on a realistic dilemma this role hits",
};

export interface ProfileCredential {
  name: string;
  /** True when the field legally or practically requires it to work. */
  required: boolean;
  note: string;
}

/** Career stages as CareerCraft stores them (`profiles.career_level`). */
export const STORED_LEVELS = ["entry", "mid", "senior", "lead", "manager", "director", "vp", "c-level"] as const;
export type StoredLevel = (typeof STORED_LEVELS)[number];

export interface FieldProfile {
  field: string;
  /** The standard job title for what was typed ("sparky" → "Electrician"); the input itself when unsure. */
  canonicalTitle: string;
  /** What each stored career stage is called in this field ("entry" → "Apprentice"). Stages the field lacks are absent. */
  levels: Partial<Record<StoredLevel, string>>;
  /** Share of a real interview spent on craft knowledge vs. behaviour, 0.2–0.8. */
  technicalWeight: number;
  /** Core competencies hiring in this field screens for. Empty for the neutral fallback — never guessed. */
  keySkills: string[];
  /** Domain formats this field really interviews with, most typical first. */
  domainFormats: DomainFormat[];
  /** Licences/certifications the field expects. Model knowledge, NOT a cited source. */
  credentials: ProfileCredential[];
  /** "model" when derived for this field; "neutral" when derivation failed or was unavailable. */
  source: "model" | "neutral";
  /** Neutral because the input isn't a job at all, as opposed to a failed lookup — safe to cache. */
  notOccupation?: boolean;
}

const NEUTRAL_FORMATS: DomainFormat[] = ["technical", "practical", "case_study"];

/** Safe for any occupation: balanced weights, formats every field can answer, no asserted skills. */
export function neutralProfile(field: string): FieldProfile {
  return {
    field,
    canonicalTitle: field,
    levels: {},
    technicalWeight: 0.5,
    keySkills: [],
    domainFormats: NEUTRAL_FORMATS,
    credentials: [],
    source: "neutral",
  };
}

const cleanText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s && s.length <= max ? s : null;
};

// Models write booleans as "true"/"false" strings about as often as real ones.
const isTrue = (v: unknown) => v === true || (typeof v === "string" && v.trim().toLowerCase() === "true");
const isFalse = (v: unknown) => v === false || (typeof v === "string" && v.trim().toLowerCase() === "false");

/** Stage labels a model writes instead of leaving the stage out. */
const NO_SUCH_STAGE = /^(n\/?a|not applicable|none|no equivalent|-+|—)$/i;

/**
 * Validate a model-described profile. Anything malformed degrades field by
 * field to the neutral value rather than failing the whole profile; a response
 * with nothing usable returns null so the caller falls back to neutral.
 */
export function parseFieldProfile(field: string, raw: unknown): FieldProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Gibberish or a non-job ("asdf", a company name) gets the neutral profile —
  // never a confident description with invented licences.
  if (isFalse(r.isOccupation)) return { ...neutralProfile(field), notOccupation: true };

  const keySkills = [
    ...new Set((Array.isArray(r.keySkills) ? r.keySkills : []).map((s) => cleanText(s, 60)).filter((s): s is string => !!s)),
  ].slice(0, 6);

  const allowed = new Set<string>(DOMAIN_FORMATS);
  const domainFormats = [
    ...new Set(
      (Array.isArray(r.domainFormats) ? r.domainFormats : [])
        .map((f) => (typeof f === "string" ? f.trim().toLowerCase().replace(/[\s-]+/g, "_") : ""))
        .filter((f): f is DomainFormat => allowed.has(f)),
    ),
  ];

  const credentials = (Array.isArray(r.credentials) ? r.credentials : [])
    .map((c): ProfileCredential | null => {
      if (!c || typeof c !== "object") return null;
      const o = c as Record<string, unknown>;
      const name = cleanText(o.name, 80);
      if (!name) return null;
      return { name, required: isTrue(o.required), note: cleanText(o.note, 200) ?? "" };
    })
    .filter((c): c is ProfileCredential => c !== null)
    .slice(0, 8);

  const rawLevels = r.levels && typeof r.levels === "object" ? (r.levels as Record<string, unknown>) : {};
  const levels: Partial<Record<StoredLevel, string>> = {};
  for (const stage of STORED_LEVELS) {
    const label = cleanText(rawLevels[stage], 40);
    if (label && !NO_SUCH_STAGE.test(label)) levels[stage] = label;
  }

  const weight = Number(r.technicalWeight);
  if (keySkills.length === 0 && domainFormats.length === 0) return null;

  return {
    field,
    canonicalTitle: cleanText(r.canonicalTitle, 60) ?? field,
    levels,
    technicalWeight: Number.isFinite(weight) ? Math.min(0.8, Math.max(0.2, weight)) : 0.5,
    keySkills,
    domainFormats: domainFormats.length > 0 ? domainFormats : NEUTRAL_FORMATS,
    credentials,
    source: "model",
  };
}

const FORMAT_PLAIN: Record<DomainFormat, string> = {
  technical: "knowledge of the job",
  practical: "hands-on 'walk me through it' tasks",
  case_study: "realistic scenarios",
  coding: "coding",
  system_design: "system design",
};

/**
 * One sentence on what interviews in this field feel like, for a learner
 * confirming their role ("Electrician — mostly hands-on tasks…"). Built from
 * the profile rather than asked for, so it can't drift from what the
 * interview loop actually does with these weights and formats.
 */
export function describeInterviewStyle(p: FieldProfile): string {
  const formats = p.domainFormats.slice(0, 3).map((f) => FORMAT_PLAIN[f]);
  const list = formats.length > 1 ? `${formats.slice(0, -1).join(", ")} and ${formats.at(-1)}` : formats[0];
  const balance =
    p.technicalWeight >= 0.65
      ? "Interviews focus mostly on the craft"
      : p.technicalWeight <= 0.4
        ? "Interviews focus mostly on how you work with people"
        : "Interviews balance the craft with how you work with people";
  return `${balance}, through ${list}.`;
}

export type SeniorityBand = "junior" | "mid" | "senior" | "lead" | "manager";

/**
 * The one reading of seniority every rule shares. Accepts the profile's stored
 * levels (entry … c-level), onboarding's persona levels (student … exec) and
 * free text, so "c-level" or "student" no longer fall through to mid-level.
 */
export function seniorityBand(seniority?: string): SeniorityBand {
  const s = seniority ?? "";
  if (/manager|director|head|chief|c-level|\bvp\b|\bexec|\bceo\b|founder|owner/i.test(s)) return "manager";
  if (/lead|staff|principal|supervisor/i.test(s)) return "lead";
  if (/senior/i.test(s)) return "senior";
  if (/junior|entry|intern|graduate|associate|trainee|apprentice|student/i.test(s)) return "junior";
  return "mid";
}

/**
 * How seniority shifts an interview, in any field: craft depth peaks at senior
 * and leadership focus climbs with rank.
 */
export function seniorityWeights(seniority?: string): { depth: number; leadership: number } {
  return {
    manager: { depth: 0.6, leadership: 0.9 },
    lead: { depth: 0.85, leadership: 0.7 },
    senior: { depth: 0.9, leadership: 0.5 },
    junior: { depth: 0.7, leadership: 0.1 },
    mid: { depth: 0.8, leadership: 0.3 },
  }[seniorityBand(seniority)];
}
