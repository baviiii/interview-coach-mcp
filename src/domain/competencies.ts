/**
 * What behavioural questions test, and in which words.
 *
 * Every story question targets one competency. By default those are the plain
 * competencies any panel asks about (ownership, disagreement, a mistake…).
 * For a public-sector role the learner can pick the framework the panel will
 * actually mark against, and the competencies become that framework's
 * capabilities, named exactly as the role description names them:
 *
 *   aps  Australian Public Service — Integrated Leadership System (ILS).
 *        APS 1–6 and EL/SES use different names for the same five clusters
 *        (apsc.gov.au, "ILS — A guide to the Integrated Leadership System").
 *   nsw  NSW Public Sector Capability Framework, version 2 (2020): sixteen
 *        core capabilities in four groups, plus four People Management
 *        capabilities for people who manage people (psc.nsw.gov.au).
 *
 * The NSW Business Enablers group (Finance, Technology, Procurement and
 * Contract Management, Project Management) is left out on purpose: those are
 * assessed as skills, not with "tell me about a time" stories.
 *
 * A competency's key is what interview_stories stores, so keys are stable:
 * generic keys are bare ("ownership"), framework keys are namespaced
 * ("aps:results", "nsw:deliver").
 */

import type { StorySnapshot } from "../types.js";
import { seniorityBand } from "./field-profile.js";

export type { StorySnapshot };

export interface Competency {
  key: string;
  /** What the learner and the panel call it. */
  label: string;
  /** What the question must get at — goes into the prompt verbatim. */
  intent: string;
}

export const FRAMEWORK_IDS = ["aps", "nsw"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const FRAMEWORK_NAMES: Record<FrameworkId, string> = {
  aps: "APS Integrated Leadership System (ILS)",
  nsw: "NSW Public Sector Capability Framework",
};

/** The five NSW capability levels. They describe complexity, not grades. */
export const NSW_LEVELS = ["Foundational", "Intermediate", "Adept", "Advanced", "Highly Advanced"] as const;
export type NswLevel = (typeof NSW_LEVELS)[number];

/* ── generic ──────────────────────────────────────────────────────────── */

const GENERIC: Competency[] = [
  { key: "ownership", label: "Ownership", intent: "a piece of work they personally drove from start to finish: what THEY decided, not what the team did" },
  { key: "conflict", label: "Working through disagreement", intent: "a real clash with a colleague, manager or client, and how it was resolved" },
  { key: "failure", label: "Accountability", intent: "a mistake or a call that went wrong: what they owned, fixed, and changed afterwards" },
  { key: "pressure", label: "Prioritising under pressure", intent: "competing deadlines or a crisis: what they chose, and what they let slip" },
  { key: "stakeholder", label: "Handling a difficult stakeholder", intent: "a difficult customer, client, patient or stakeholder, and how they handled them" },
  { key: "collaboration", label: "Collaboration", intent: "getting something done with people outside their own team or unlike them" },
  { key: "adaptability", label: "Adaptability", intent: "a sudden change of plan, scope or role, and how they adjusted" },
  { key: "influence", label: "Influence without authority", intent: "changing someone's mind when they couldn't tell them what to do" },
  { key: "leadership", label: "Leading people", intent: "lifting someone's performance, or making an unpopular call and carrying the team with them" },
  { key: "learning", label: "Learning fast", intent: "picking up something unfamiliar quickly in order to deliver" },
];

const GENERIC_ORDER: Record<string, string[]> = {
  junior: ["ownership", "collaboration", "learning", "pressure", "failure", "stakeholder", "conflict", "adaptability", "influence", "leadership"],
  mid: ["ownership", "conflict", "failure", "pressure", "stakeholder", "influence", "adaptability", "collaboration", "learning", "leadership"],
  senior: ["influence", "conflict", "failure", "ownership", "pressure", "stakeholder", "leadership", "adaptability", "collaboration", "learning"],
  leader: ["leadership", "influence", "conflict", "failure", "pressure", "stakeholder", "ownership", "adaptability", "collaboration", "learning"],
};

/* ── APS ILS ──────────────────────────────────────────────────────────── */

/** [APS 1–6 name, EL/SES name, what a story for it shows]. */
const APS: Record<string, [string, string, string]> = {
  "aps:strategic": [
    "Supports strategic direction",
    "Shapes strategic thinking",
    "connecting their work to the bigger purpose: using information to see an issue early, or making a judgement call that changed the plan",
  ],
  "aps:results": [
    "Achieves results",
    "Achieves results",
    "delivering something important despite obstacles — planning it, managing it and seeing it through to a measurable outcome",
  ],
  "aps:relationships": [
    "Supports productive working relationships",
    "Cultivates productive working relationships",
    "building or repairing a working relationship, working across teams, or guiding and developing someone",
  ],
  "aps:integrity": [
    "Displays personal drive and integrity",
    "Exemplifies personal drive and integrity",
    "acting professionally under pressure: owning a mistake, staying resilient, or doing the right thing when it was harder",
  ],
  "aps:influence": [
    "Communicates with influence",
    "Communicates with influence",
    "explaining something complex clearly, listening to concerns, and persuading or negotiating to an outcome",
  ],
};

/* ── NSW capability framework ─────────────────────────────────────────── */

/** [name as written, the framework's own one-line description]. */
const NSW: Record<string, [string, string]> = {
  // Personal Attributes
  "nsw:resilience": ["Display Resilience and Courage", "being open and honest, prepared to express their views, and willing to accept and commit to change"],
  "nsw:integrity": ["Act with Integrity", "being ethical and professional, and upholding and promoting the public sector values"],
  "nsw:manage-self": ["Manage Self", "showing drive and motivation, an ability to self-reflect and a commitment to learning"],
  "nsw:diversity": ["Value Diversity and Inclusion", "inclusive behaviour and respect for diverse backgrounds, experiences and perspectives"],
  // Relationships
  "nsw:communicate": ["Communicate Effectively", "communicating clearly, actively listening to others, and responding with understanding and respect"],
  "nsw:customer": ["Commit to Customer Service", "providing customer-focused services in line with public sector and organisational objectives"],
  "nsw:collaborate": ["Work Collaboratively", "collaborating with others and valuing their contribution"],
  "nsw:influence": ["Influence and Negotiate", "gaining consensus and commitment from others, and resolving issues and conflicts"],
  // Results
  "nsw:deliver": ["Deliver Results", "achieving results through the efficient use of resources and a commitment to quality outcomes"],
  "nsw:plan": ["Plan and Prioritise", "planning to achieve priority outcomes and responding flexibly to changing circumstances"],
  "nsw:problem-solve": ["Think and Solve Problems", "thinking, analysing and considering the broader context to develop practical solutions"],
  "nsw:accountability": ["Demonstrate Accountability", "being proactive and responsible for their own actions, and adhering to legislation, policy and guidelines"],
  // People Management
  "nsw:develop-people": ["Manage and Develop People", "engaging and motivating staff, and developing capability and potential in others"],
  "nsw:direction": ["Inspire Direction and Purpose", "communicating goals, priorities and vision, and recognising achievements"],
  "nsw:business-outcomes": ["Optimise Business Outcomes", "managing people and resources effectively to achieve public value"],
  "nsw:change": ["Manage Reform and Change", "supporting, promoting and championing change, and helping others to engage with it"],
};

const NSW_ORDER = {
  staff: [
    "nsw:deliver", "nsw:collaborate", "nsw:communicate", "nsw:problem-solve", "nsw:customer", "nsw:resilience",
    "nsw:plan", "nsw:accountability", "nsw:influence", "nsw:integrity", "nsw:manage-self", "nsw:diversity",
  ],
  manager: [
    "nsw:develop-people", "nsw:direction", "nsw:change", "nsw:deliver", "nsw:influence", "nsw:business-outcomes",
    "nsw:communicate", "nsw:resilience", "nsw:accountability", "nsw:collaborate", "nsw:integrity", "nsw:plan",
  ],
};

/* ── building the set ─────────────────────────────────────────────────── */

const leads = (seniority: string) => {
  const band = seniorityBand(seniority);
  return band === "lead" || band === "manager";
};
const senior = (seniority: string) => {
  const band = seniorityBand(seniority);
  return band === "senior" || band === "lead" || band === "manager";
};

/**
 * The competencies a behavioural question can target, most important first
 * for this learner's level.
 */
export function competencySet(opts: { framework?: FrameworkId; seniority?: string }): Competency[] {
  const seniority = opts.seniority ?? "";
  if (opts.framework === "aps") {
    const exec = senior(seniority);
    const order = exec
      ? ["aps:strategic", "aps:influence", "aps:relationships", "aps:results", "aps:integrity"]
      : ["aps:results", "aps:relationships", "aps:influence", "aps:integrity", "aps:strategic"];
    return order.map((key) => {
      const [staff, executive, shows] = APS[key]!;
      const label = exec ? executive : staff;
      return { key, label, intent: `${label} (APS ILS) — ${shows}` };
    });
  }
  if (opts.framework === "nsw") {
    return NSW_ORDER[leads(seniority) ? "manager" : "staff"].map((key) => {
      const [label, description] = NSW[key]!;
      return { key, label, intent: `${label} (NSW capability) — ${description}` };
    });
  }
  const band = seniorityBand(seniority);
  const order = GENERIC_ORDER[band === "junior" ? "junior" : band === "senior" ? "senior" : leads(seniority) ? "leader" : "mid"]!;
  return order.map((key) => GENERIC.find((c) => c.key === key)!);
}

/** Any competency's label by key, whichever set it came from. */
export function competencyLabel(key: string, seniority?: string): string {
  const generic = GENERIC.find((c) => c.key === key);
  if (generic) return generic.label;
  if (APS[key]) return senior(seniority ?? "") ? APS[key]![1] : APS[key]![0];
  if (NSW[key]) return NSW[key]![0];
  return key;
}

export function isCompetencyKey(key: unknown): key is string {
  return typeof key === "string" && (GENERIC.some((c) => c.key === key) || key in APS || key in NSW);
}

/* ── stories ──────────────────────────────────────────────────────────── */

export type StoryStrength = "none" | "weak" | "usable" | "strong";

/** Same cut-offs the debrief's story bank uses: 8+ strong, 6+ usable. */
export function storyStrength(score: number | null | undefined): StoryStrength {
  if (score === null || score === undefined) return "none";
  if (score >= 8) return "strong";
  if (score >= 6) return "usable";
  return "weak";
}

const RANK: Record<StoryStrength, number> = { none: 0, weak: 1, usable: 2, strong: 3 };

/**
 * Puts the competencies they most need a story for first: none yet, then
 * weak, then usable, then strong. Within a strength the level's own priority
 * holds, so a manager with no stories still starts on leading people.
 */
export function orderByStoryNeed(set: Competency[], stories: StorySnapshot[] | undefined): Competency[] {
  if (!stories?.length) return set;
  const strength = new Map(stories.map((s) => [s.competency, storyStrength(s.bestScore)]));
  return set
    .map((c, i) => ({ c, i, rank: RANK[strength.get(c.key) ?? "none"] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);
}
