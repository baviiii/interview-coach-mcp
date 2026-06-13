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

export function getCareerPath(field: string): CareerPath {
  return CAREER_PATHS[field] ?? CAREER_PATHS["default"]!;
}

export function getSeniorityModifier(path: CareerPath, seniority?: string) {
  return path.seniorityModifiers[seniority ?? "Mid-Level"] ?? path.seniorityModifiers["Mid-Level"]!;
}
