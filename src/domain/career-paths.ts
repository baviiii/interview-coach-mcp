/** Career-path weighting + seniority modifiers. Ported from interview-ai. */

export interface CareerPath {
  technicalWeight: number;
  behavioralWeight: number;
  keySkills: string[];
  seniorityModifiers: Record<string, { technicalDepth: number; leadershipFocus: number }>;
}

export const CAREER_PATHS: Record<string, CareerPath> = {
  "Software Engineering": {
    technicalWeight: 0.6,
    behavioralWeight: 0.4,
    keySkills: ["Data Structures", "Algorithms", "System Design", "Problem Solving", "Communication"],
    seniorityModifiers: {
      Junior: { technicalDepth: 0.7, leadershipFocus: 0.1 },
      "Mid-Level": { technicalDepth: 0.8, leadershipFocus: 0.3 },
      Senior: { technicalDepth: 0.9, leadershipFocus: 0.5 },
      Lead: { technicalDepth: 0.85, leadershipFocus: 0.7 },
      Manager: { technicalDepth: 0.6, leadershipFocus: 0.9 },
    },
  },
  "DevOps & SRE": {
    technicalWeight: 0.65,
    behavioralWeight: 0.35,
    keySkills: ["Cloud Services", "System Design", "Security", "Problem Solving"],
    seniorityModifiers: {
      Junior: { technicalDepth: 0.7, leadershipFocus: 0.1 },
      "Mid-Level": { technicalDepth: 0.85, leadershipFocus: 0.25 },
      Senior: { technicalDepth: 0.95, leadershipFocus: 0.5 },
    },
  },
  "Data Science & ML": {
    technicalWeight: 0.7,
    behavioralWeight: 0.3,
    keySkills: ["Algorithms", "Databases", "Problem Solving", "Critical Thinking"],
    seniorityModifiers: {
      Junior: { technicalDepth: 0.75, leadershipFocus: 0.1 },
      "Mid-Level": { technicalDepth: 0.85, leadershipFocus: 0.3 },
      Senior: { technicalDepth: 0.9, leadershipFocus: 0.5 },
    },
  },
  "Product Management": {
    technicalWeight: 0.3,
    behavioralWeight: 0.7,
    keySkills: ["Communication", "Leadership", "Problem Solving", "Critical Thinking"],
    seniorityModifiers: {
      Junior: { technicalDepth: 0.4, leadershipFocus: 0.3 },
      "Mid-Level": { technicalDepth: 0.5, leadershipFocus: 0.5 },
      Senior: { technicalDepth: 0.5, leadershipFocus: 0.7 },
    },
  },
  default: {
    technicalWeight: 0.5,
    behavioralWeight: 0.5,
    keySkills: ["Communication", "Problem Solving", "Teamwork", "Adaptability"],
    seniorityModifiers: {
      Junior: { technicalDepth: 0.6, leadershipFocus: 0.2 },
      "Mid-Level": { technicalDepth: 0.7, leadershipFocus: 0.4 },
      Senior: { technicalDepth: 0.8, leadershipFocus: 0.6 },
    },
  },
};

/**
 * Free-text field names ("Software Engineer", "sre", "ML engineer") mapped onto
 * the four tuned paths. Without this, an exact-key lookup misses almost every
 * real input and silently falls back to `default` — whose bland key skills then
 * get injected into the interview prompt, which is exactly how you get generic
 * questions.
 */
const FIELD_ALIASES: Array<[RegExp, keyof typeof CAREER_PATHS]> = [
  [/\b(swe|software|backend|back-end|frontend|front-end|full ?stack|web developer|programmer)\b/, "Software Engineering"],
  [/\b(devops|sre|site reliability|platform|infrastructure|cloud engineer)\b/, "DevOps & SRE"],
  [/\b(data scien|machine learning|ml engineer|mlops|ai engineer|data engineer|analytics engineer)\b/, "Data Science & ML"],
  [/\b(product manage|product owner|\bpm\b|program manage)\b/, "Product Management"],
];

function normalizeField(field: string): string {
  return field.toLowerCase().replace(/[&/_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Resolves a field to its tuned path. `matched` is false when we fell back to
 * the field-neutral default — callers use that to OMIT generic guidance rather
 * than assert it (research + the learner's own skill matrix carry the focus for
 * fields we have no opinion about).
 */
export function resolveCareerPath(field: string | undefined): { path: CareerPath; matched: boolean } {
  const normalized = normalizeField(field ?? "");
  if (!normalized) return { path: CAREER_PATHS["default"]!, matched: false };

  for (const key of Object.keys(CAREER_PATHS)) {
    if (key !== "default" && normalizeField(key) === normalized) {
      return { path: CAREER_PATHS[key]!, matched: true };
    }
  }
  for (const [pattern, key] of FIELD_ALIASES) {
    if (pattern.test(normalized)) return { path: CAREER_PATHS[key]!, matched: true };
  }
  return { path: CAREER_PATHS["default"]!, matched: false };
}

export function getCareerPath(field: string): CareerPath {
  return resolveCareerPath(field).path;
}

export function getSeniorityModifier(path: CareerPath, seniority?: string) {
  return path.seniorityModifiers[seniority ?? "Mid-Level"] ?? path.seniorityModifiers["Mid-Level"]!;
}
