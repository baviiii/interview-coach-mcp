/**
 * Career-roadmap scaffolding. Deterministic phase math (week ranges, cadence,
 * intensity) so two learners with the same horizon get structurally comparable
 * plans; the model fills each phase with personalized content.
 */

export type Intensity = "light" | "standard" | "intense";

export interface RoadmapPhaseSkeleton {
  index: number;
  name: string;
  fromWeek: number;
  toWeek: number;
  intent: string;
}

export interface RoadmapSkeleton {
  horizonWeeks: number;
  hoursPerWeek: number;
  totalHours: number;
  intensity: Intensity;
  mocksPerWeek: number;
  drillsPerWeek: number;
  phases: RoadmapPhaseSkeleton[];
}

const SHORT_PHASES: Array<[string, number, string]> = [
  ["Assess & Stabilize", 0.3, "Baseline every target skill, fix the bleeding (weakest 1–2 skills), set the routine."],
  ["Sharpen", 0.45, "Deliberate practice on the gap skills; one visible artifact (project/cert progress) started."],
  ["Prove", 0.25, "Full mock loops under pressure; convert practice into interview-ready stories and answers."],
];

const LONG_PHASES: Array<[string, number, string]> = [
  ["Foundation", 0.25, "Baseline skills, close prerequisite gaps, lock the weekly routine and study system."],
  ["Build", 0.35, "Deep skill work + certification prep; ship one portfolio-grade artifact."],
  ["Prove", 0.25, "Mock interviews at full difficulty, cert exam(s) sat, stories quantified and rehearsed."],
  ["Land", 0.15, "Applications at volume, targeted networking, company-specific prep, offer handling."],
];

export function roadmapSkeleton(horizonWeeks: number, hoursPerWeek: number): RoadmapSkeleton {
  const defs = horizonWeeks <= 6 ? SHORT_PHASES : LONG_PHASES;
  const intensity: Intensity = hoursPerWeek >= 10 ? "intense" : hoursPerWeek >= 5 ? "standard" : "light";

  let cursor = 1;
  const phases: RoadmapPhaseSkeleton[] = defs.map(([name, share, intent], i) => {
    const isLast = i === defs.length - 1;
    const span = Math.max(1, Math.round(horizonWeeks * share));
    const fromWeek = cursor;
    const toWeek = isLast ? horizonWeeks : Math.min(horizonWeeks, cursor + span - 1);
    cursor = toWeek + 1;
    return { index: i + 1, name, fromWeek, toWeek, intent };
  });

  return {
    horizonWeeks,
    hoursPerWeek,
    totalHours: horizonWeeks * hoursPerWeek,
    intensity,
    mocksPerWeek: intensity === "intense" ? 3 : intensity === "standard" ? 2 : 1,
    drillsPerWeek: intensity === "intense" ? 7 : intensity === "standard" ? 5 : 3,
    phases,
  };
}
