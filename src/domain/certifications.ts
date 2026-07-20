/**
 * Curated certification catalog — the deterministic backbone for cert-based
 * career guidance. The model personalizes; this file supplies the facts
 * (issuer, level, skills vouched for, prep effort, market signal) so advice is
 * grounded in real credentials, not hallucinated ones. Skills use the same
 * names as the taxonomy/skill matrix so certs feed proficiency directly.
 */

import type { ResearchSnippet } from "../adapters/research/port.js";
import type { CertificationStatus } from "../types.js";

export type CertLevel = "foundational" | "associate" | "professional" | "specialty" | "expert";

export interface CertCatalogEntry {
  id: string;
  name: string;
  issuer: string;
  level: CertLevel;
  /** Career paths this cert serves — matched loosely against the learner's field. */
  careerPaths: string[];
  /** Skills (taxonomy names) the cert vouches for. */
  skills: string[];
  /** Typical prep effort range in hours for someone near the target level. */
  prepHours: [number, number];
  examCostUsd: number;
  /** Years valid; null = does not expire. */
  validityYears: number | null;
  /** Why employers care — one line, used verbatim in prompts. */
  marketSignal: string;
  /** Cert ids (or free-text experience notes) that should come first. */
  prereqs?: string[];
  /** Normalized fragments used to match user-entered names. */
  aliases: string[];
}

export const CERT_CATALOG: CertCatalogEntry[] = [
  {
    id: "aws-ccp",
    name: "AWS Certified Cloud Practitioner",
    issuer: "Amazon Web Services",
    level: "foundational",
    careerPaths: ["Software Engineering", "DevOps & SRE", "IT Support"],
    skills: ["Cloud Services"],
    prepHours: [20, 40],
    examCostUsd: 100,
    validityYears: 3,
    marketSignal: "Baseline cloud literacy; the cheapest credible signal for cloud-adjacent roles.",
    aliases: ["cloud practitioner", "clf-c02", "aws ccp"],
  },
  {
    id: "aws-saa",
    name: "AWS Certified Solutions Architect – Associate",
    issuer: "Amazon Web Services",
    level: "associate",
    careerPaths: ["DevOps & SRE", "Software Engineering"],
    skills: ["Cloud Services", "System Design", "Networking"],
    prepHours: [60, 120],
    examCostUsd: 150,
    validityYears: 3,
    marketSignal: "The most-requested cloud cert in job postings; proves architecture-level AWS fluency.",
    aliases: ["solutions architect associate", "saa-c03", "aws saa", "solution architect"],
  },
  {
    id: "aws-dva",
    name: "AWS Certified Developer – Associate",
    issuer: "Amazon Web Services",
    level: "associate",
    careerPaths: ["Software Engineering"],
    skills: ["Cloud Services", "Databases"],
    prepHours: [50, 100],
    examCostUsd: 150,
    validityYears: 3,
    marketSignal: "Developer-side AWS depth — serverless, SDKs, CI/CD — valued for backend roles.",
    aliases: ["developer associate", "dva-c02", "aws developer"],
  },
  {
    id: "aws-sap",
    name: "AWS Certified Solutions Architect – Professional",
    issuer: "Amazon Web Services",
    level: "professional",
    careerPaths: ["DevOps & SRE", "Software Engineering"],
    skills: ["Cloud Services", "System Design", "Security"],
    prepHours: [120, 200],
    examCostUsd: 300,
    validityYears: 3,
    marketSignal: "Senior/staff-level cloud architecture signal; strong salary correlation.",
    prereqs: ["aws-saa"],
    aliases: ["solutions architect professional", "sap-c02"],
  },
  {
    id: "aws-mls",
    name: "AWS Certified Machine Learning – Specialty",
    issuer: "Amazon Web Services",
    level: "specialty",
    careerPaths: ["Data Science & ML"],
    skills: ["Cloud Services", "Algorithms", "Databases"],
    prepHours: [80, 150],
    examCostUsd: 300,
    validityYears: 3,
    marketSignal: "Proves production-ML skills (training, deployment, MLOps) on the dominant cloud.",
    prereqs: ["aws-saa"],
    aliases: ["machine learning specialty", "mls-c01", "aws ml"],
  },
  {
    id: "az-900",
    name: "Microsoft Azure Fundamentals (AZ-900)",
    issuer: "Microsoft",
    level: "foundational",
    careerPaths: ["Software Engineering", "DevOps & SRE", "IT Support"],
    skills: ["Cloud Services"],
    prepHours: [15, 30],
    examCostUsd: 99,
    validityYears: null,
    marketSignal: "Quick, never-expires Azure literacy badge; common in Microsoft-stack shops.",
    aliases: ["azure fundamentals", "az900", "az 900"],
  },
  {
    id: "az-104",
    name: "Microsoft Azure Administrator (AZ-104)",
    issuer: "Microsoft",
    level: "associate",
    careerPaths: ["DevOps & SRE", "IT Support"],
    skills: ["Cloud Services", "Networking", "Security"],
    prepHours: [60, 100],
    examCostUsd: 165,
    validityYears: 1,
    marketSignal: "Core Azure ops credential; renewable free online, expected for Azure-first teams.",
    aliases: ["azure administrator", "az104", "az 104"],
  },
  {
    id: "gcp-ace",
    name: "Google Associate Cloud Engineer",
    issuer: "Google Cloud",
    level: "associate",
    careerPaths: ["DevOps & SRE", "Software Engineering"],
    skills: ["Cloud Services", "Networking"],
    prepHours: [50, 90],
    examCostUsd: 125,
    validityYears: 3,
    marketSignal: "Hands-on GCP deployment/ops signal; the standard GCP entry credential.",
    aliases: ["associate cloud engineer", "gcp ace"],
  },
  {
    id: "gcp-pde",
    name: "Google Professional Data Engineer",
    issuer: "Google Cloud",
    level: "professional",
    careerPaths: ["Data Science & ML", "Data Engineering"],
    skills: ["Databases", "Cloud Services", "System Design"],
    prepHours: [80, 140],
    examCostUsd: 200,
    validityYears: 2,
    marketSignal: "Top-paying cloud cert in several salary surveys; proves pipeline + warehouse design.",
    aliases: ["professional data engineer", "gcp data engineer"],
  },
  {
    id: "gcp-pmle",
    name: "Google Professional Machine Learning Engineer",
    issuer: "Google Cloud",
    level: "professional",
    careerPaths: ["Data Science & ML"],
    skills: ["Algorithms", "Cloud Services"],
    prepHours: [80, 140],
    examCostUsd: 200,
    validityYears: 2,
    marketSignal: "Production-ML design and MLOps signal on GCP; strong for ML-platform roles.",
    aliases: ["professional machine learning engineer", "ml engineer google"],
  },
  {
    id: "cka",
    name: "Certified Kubernetes Administrator (CKA)",
    issuer: "Cloud Native Computing Foundation",
    level: "professional",
    careerPaths: ["DevOps & SRE"],
    skills: ["Cloud Services", "Networking", "Security"],
    prepHours: [60, 120],
    examCostUsd: 445,
    validityYears: 2,
    marketSignal: "Hands-on lab exam (not multiple choice) — one of the highest-signal infra certs.",
    aliases: ["certified kubernetes administrator", "kubernetes administrator"],
  },
  {
    id: "ckad",
    name: "Certified Kubernetes Application Developer (CKAD)",
    issuer: "Cloud Native Computing Foundation",
    level: "associate",
    careerPaths: ["Software Engineering", "DevOps & SRE"],
    skills: ["Cloud Services"],
    prepHours: [50, 100],
    examCostUsd: 445,
    validityYears: 2,
    marketSignal: "Developer-side Kubernetes fluency; valued where teams own their deployments.",
    aliases: ["kubernetes application developer"],
  },
  {
    id: "terraform-associate",
    name: "HashiCorp Certified: Terraform Associate",
    issuer: "HashiCorp",
    level: "associate",
    careerPaths: ["DevOps & SRE"],
    skills: ["Cloud Services"],
    prepHours: [30, 60],
    examCostUsd: 70,
    validityYears: 2,
    marketSignal: "Cheap, fast IaC credential; pairs with any cloud cert to round out a platform story.",
    aliases: ["terraform associate", "terraform 003"],
  },
  {
    id: "security-plus",
    name: "CompTIA Security+",
    issuer: "CompTIA",
    level: "associate",
    careerPaths: ["Security", "DevOps & SRE", "IT Support"],
    skills: ["Security", "Networking"],
    prepHours: [40, 80],
    examCostUsd: 404,
    validityYears: 3,
    marketSignal: "DoD 8570 baseline — a hard requirement for many government/defense roles.",
    aliases: ["security+", "sec+", "sy0-701", "comptia security"],
  },
  {
    id: "cissp",
    name: "CISSP",
    issuer: "ISC2",
    level: "expert",
    careerPaths: ["Security"],
    skills: ["Security", "Leadership"],
    prepHours: [150, 300],
    examCostUsd: 749,
    validityYears: 3,
    marketSignal: "The gold-standard security leadership cert; commonly gates senior security roles.",
    prereqs: ["5+ years of paid security work (or 4 + degree)"],
    aliases: ["certified information systems security professional"],
  },
  {
    id: "oscp",
    name: "OffSec Certified Professional (OSCP)",
    issuer: "OffSec",
    level: "professional",
    careerPaths: ["Security"],
    skills: ["Security", "Networking"],
    prepHours: [200, 400],
    examCostUsd: 1749,
    validityYears: 3,
    marketSignal: "24-hour practical hacking exam — the strongest offensive-security proof of skill.",
    aliases: ["offensive security certified professional"],
  },
  {
    id: "ccna",
    name: "Cisco Certified Network Associate (CCNA)",
    issuer: "Cisco",
    level: "associate",
    careerPaths: ["Networking", "DevOps & SRE", "IT Support"],
    skills: ["Networking", "Security"],
    prepHours: [60, 120],
    examCostUsd: 300,
    validityYears: 3,
    marketSignal: "The default networking credential; expected for network and many infra roles.",
    aliases: ["cisco certified network associate", "200-301"],
  },
  {
    id: "databricks-de",
    name: "Databricks Certified Data Engineer Associate",
    issuer: "Databricks",
    level: "associate",
    careerPaths: ["Data Engineering", "Data Science & ML"],
    skills: ["Databases", "Algorithms"],
    prepHours: [40, 80],
    examCostUsd: 200,
    validityYears: 2,
    marketSignal: "Lakehouse/Spark fluency — fast-growing demand in modern data stacks.",
    aliases: ["databricks data engineer"],
  },
  {
    id: "snowpro-core",
    name: "SnowPro Core Certification",
    issuer: "Snowflake",
    level: "associate",
    careerPaths: ["Data Engineering", "Data Science & ML"],
    skills: ["Databases"],
    prepHours: [40, 70],
    examCostUsd: 175,
    validityYears: 2,
    marketSignal: "Snowflake is entrenched in analytics teams; this is its baseline credential.",
    aliases: ["snowpro", "snowflake core"],
  },
  {
    id: "pmp",
    name: "Project Management Professional (PMP)",
    issuer: "Project Management Institute",
    level: "professional",
    careerPaths: ["Product Management", "Delivery & Program Management"],
    skills: ["Leadership", "Communication", "Problem Solving"],
    prepHours: [100, 180],
    examCostUsd: 575,
    validityYears: 3,
    marketSignal: "Still the most-recognized delivery credential; often a hard filter for PM/program roles.",
    prereqs: ["36 months leading projects (or 60 without a degree)"],
    aliases: ["project management professional"],
  },
  {
    id: "csm",
    name: "Certified ScrumMaster (CSM)",
    issuer: "Scrum Alliance",
    level: "foundational",
    careerPaths: ["Product Management", "Delivery & Program Management"],
    skills: ["Leadership", "Communication", "Teamwork"],
    prepHours: [16, 24],
    examCostUsd: 500,
    validityYears: 2,
    marketSignal: "Fast agile-fluency badge; useful early, low ceiling later.",
    aliases: ["certified scrummaster", "scrum master"],
  },
  {
    id: "cspo",
    name: "Certified Scrum Product Owner (CSPO)",
    issuer: "Scrum Alliance",
    level: "foundational",
    careerPaths: ["Product Management"],
    skills: ["Communication", "Critical Thinking", "Leadership"],
    prepHours: [16, 24],
    examCostUsd: 500,
    validityYears: 2,
    marketSignal: "Entry product-ownership signal for engineers moving toward product.",
    aliases: ["certified scrum product owner", "product owner"],
  },
  {
    id: "comptia-aplus",
    name: "CompTIA A+",
    issuer: "CompTIA",
    level: "foundational",
    careerPaths: ["IT Support"],
    skills: ["Networking", "Problem Solving"],
    prepHours: [60, 100],
    examCostUsd: 506,
    validityYears: 3,
    marketSignal: "The standard break-into-IT credential (two exams).",
    aliases: ["a+", "comptia a plus", "220-1101"],
  },
];

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();

/** Match a user-entered certification name (and optional issuer) to the catalog. */
export function matchCertification(name: string, issuer?: string): CertCatalogEntry | null {
  const n = norm(name);
  if (!n) return null;
  let best: CertCatalogEntry | null = null;
  let bestLen = 0;
  for (const entry of CERT_CATALOG) {
    const candidates = [norm(entry.name), ...entry.aliases.map(norm)];
    for (const c of candidates) {
      if ((n.includes(c) || c.includes(n)) && c.length > bestLen) {
        best = entry;
        bestLen = c.length;
      }
    }
  }
  if (!best && issuer) {
    // Issuer alone is too weak to match on; only used to break exact-name ties above.
    return null;
  }
  return best;
}

/** active / expiring_soon (≤90 days) / expired, from ISO date strings. */
export function certStatus(expiryDate?: string | null, now = new Date()): CertificationStatus {
  if (!expiryDate) return "active";
  const exp = new Date(expiryDate);
  if (Number.isNaN(exp.getTime())) return "active";
  if (exp < now) return "expired";
  const soon = new Date(now);
  soon.setDate(soon.getDate() + 90);
  return exp <= soon ? "expiring_soon" : "active";
}

const LEVEL_FIT: Record<string, CertLevel[]> = {
  Junior: ["foundational", "associate"],
  "Mid-Level": ["associate", "professional"],
  Senior: ["professional", "specialty", "expert"],
  Lead: ["professional", "specialty", "expert"],
  Manager: ["professional", "expert"],
};

export interface CertSuggestion extends CertCatalogEntry {
  levelFit: "ideal" | "stretch" | "adjacent";
  prereqNote?: string;
}

/**
 * Deterministic next-cert shortlist for a field + seniority, excluding what the
 * learner already holds. The model then personalizes ordering and reasoning.
 */
export function nextCertSuggestions(opts: {
  field?: string;
  seniority?: string;
  ownedCatalogIds: string[];
  max?: number;
  /**
   * When the field matches no catalog career path, fall back to the whole tech
   * catalog. Defaults to true (legacy behavior). Pass FALSE for non-tech fields
   * that have researched credentials — otherwise a nurse gets AWS suggestions.
   */
  fallbackToAll?: boolean;
}): CertSuggestion[] {
  const fieldNorm = norm(opts.field ?? "Software Engineering");
  const owned = new Set(opts.ownedCatalogIds);
  const idealLevels = LEVEL_FIT[opts.seniority ?? "Mid-Level"] ?? LEVEL_FIT["Mid-Level"]!;

  const pool = CERT_CATALOG.filter((e) => !owned.has(e.id)).filter((e) =>
    e.careerPaths.some((p) => {
      const pn = norm(p);
      return pn.includes(fieldNorm) || fieldNorm.includes(pn);
    }),
  );
  const candidates =
    pool.length > 0
      ? pool
      : opts.fallbackToAll === false
        ? [] // non-tech field: let researched credentials fill the list instead
        : CERT_CATALOG.filter((e) => !owned.has(e.id) && e.level !== "expert");

  const scored = candidates.map((e) => {
    const fit: CertSuggestion["levelFit"] = idealLevels.includes(e.level)
      ? "ideal"
      : idealLevels[idealLevels.length - 1] === "associate" && e.level === "professional"
        ? "stretch"
        : "adjacent";
    const unmetPrereqs = (e.prereqs ?? []).filter((p) => !owned.has(p));
    return {
      ...e,
      levelFit: fit,
      prereqNote: unmetPrereqs.length ? `Prerequisite first: ${unmetPrereqs.join(", ")}` : undefined,
    };
  });

  const fitRank = { ideal: 0, stretch: 1, adjacent: 2 } as const;
  scored.sort((a, b) => fitRank[a.levelFit] - fitRank[b.levelFit] || a.prepHours[0] - b.prepHours[0]);
  return scored.slice(0, opts.max ?? 6);
}

/* ── credential candidates: curated catalog ∪ researched (any field) ───────── */

/**
 * One credential the model may recommend. Either a curated-catalog entry (full
 * deterministic facts, `source: "catalog"`) or one researched from a real source
 * for a non-tech field (`source` = its URL; cost/effort unknown). The merge is
 * how the cert tools escape the 25-entry tech catalog without ever inventing a
 * credential — researched ones always carry their source.
 */
export interface CredentialCandidate {
  id: string | null;
  name: string;
  level?: CertLevel;
  prepHours?: [number, number];
  examCostUsd?: number | null;
  marketSignal: string;
  /** "catalog" or the URL it was researched from. */
  source: string;
  levelFit?: CertSuggestion["levelFit"];
  prereqNote?: string;
}

/** A research credential snippet looks like "Page Title: extract…" (Wikipedia)
 *  or a forum title. Promote only ones whose head reads like a credential NAME
 *  (short, no sentence punctuation); skip ramble — it still shows as a real-world
 *  signal in the prompt, just not as a named pick. */
function credentialNameFrom(snippet: ResearchSnippet): string | null {
  const colon = snippet.text.indexOf(":");
  const head = (colon > 0 ? snippet.text.slice(0, colon) : snippet.text).replace(/\s+/g, " ").trim();
  if (!head) return null;
  const words = head.split(" ");
  const looksLikeName = head.length <= 70 && words.length <= 8 && !/[.?!]/.test(head);
  return looksLikeName ? head : null;
}

/** Merge curated suggestions with researched credentials, dedup by name, cap. */
export function mergeCredentialCandidates(
  catalog: CertSuggestion[],
  researched: ResearchSnippet[],
  max = 8,
): CredentialCandidate[] {
  const out: CredentialCandidate[] = [];
  const seen = new Set<string>();

  for (const c of catalog) {
    const key = norm(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: c.id,
      name: c.name,
      level: c.level,
      prepHours: c.prepHours,
      examCostUsd: c.examCostUsd,
      marketSignal: c.marketSignal,
      source: "catalog",
      levelFit: c.levelFit,
      prereqNote: c.prereqNote,
    });
  }

  for (const snippet of researched) {
    const name = credentialNameFrom(snippet);
    if (!name) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: null,
      name,
      marketSignal: snippet.text.length > 160 ? `${snippet.text.slice(0, 159)}…` : snippet.text,
      source: snippet.sourceUrl,
    });
  }

  return out.slice(0, max);
}

/** Render candidates as the prompt's CANDIDATE CREDENTIALS lines. */
export function formatCredentialCandidates(cands: CredentialCandidate[]): string {
  if (cands.length === 0) return "(none — rely on the real-world signals above; do not invent credentials)";
  return cands
    .map((c) => {
      const id = c.id ?? "—";
      const level = c.level ?? "n/a";
      const fit = c.levelFit ? ` (${c.levelFit} fit)` : "";
      const prep = c.prepHours ? `${c.prepHours[0]}-${c.prepHours[1]}h` : "prep n/a";
      const cost = c.examCostUsd != null ? `$${c.examCostUsd}` : "cost n/a";
      const extra = c.prereqNote ? ` :: ${c.prereqNote}` : "";
      return `- ${id} :: ${c.name} :: ${level}${fit} :: ${prep} :: ${cost} :: ${c.marketSignal} :: source: ${c.source}${extra}`;
    })
    .join("\n");
}
