/**
 * Curated certification catalog — a lookup table of facts (issuer, level,
 * skills vouched for, prep effort, cost, market signal) for credentials we
 * happen to know well. It does NOT decide what to suggest: suggestions come
 * from research and the field profile, and the catalog only enriches a
 * suggestion it recognises. That keeps its tech-heavy contents from leaking
 * into fields it knows nothing about.
 */

import type { ResearchSnippet } from "../adapters/research/port.js";
import type { ProfileCredential } from "./field-profile.js";
import type { CertificationStatus } from "../types.js";

export type CertLevel = "foundational" | "associate" | "professional" | "specialty" | "expert";

export interface CertCatalogEntry {
  id: string;
  name: string;
  issuer: string;
  level: CertLevel;
  /** Skills the cert vouches for. */
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
  // Whole words only: raw substrings matched "RN" inside "kubernetes".
  const within = (outer: string, inner: string) => inner.length >= 3 && ` ${outer} `.includes(` ${inner} `);
  let best: CertCatalogEntry | null = null;
  let bestLen = 0;
  for (const entry of CERT_CATALOG) {
    const candidates = [norm(entry.name), ...entry.aliases.map(norm)];
    for (const c of candidates) {
      // A catalog name may contain the input when it's several words or a short
      // acronym ("CKA"), but not one generic word ("Associate" is not an AWS cert).
      const specific = n.includes(" ") || n.length <= 5;
      if ((n === c || within(n, c) || (specific && within(c, n))) && c.length > bestLen) {
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

const LEVEL_FIT: Record<"junior" | "mid" | "senior" | "manager", CertLevel[]> = {
  junior: ["foundational", "associate"],
  mid: ["associate", "professional"],
  senior: ["professional", "specialty", "expert"],
  manager: ["professional", "expert"],
};

function levelFitFor(level: CertLevel, seniority?: string): "ideal" | "stretch" | "adjacent" {
  const s = seniority ?? "";
  const band = /manager|director|head|chief/i.test(s)
    ? "manager"
    : /senior|lead|staff|principal/i.test(s)
      ? "senior"
      : /junior|entry|intern|graduate|trainee|apprentice/i.test(s)
        ? "junior"
        : "mid";
  const ideal = LEVEL_FIT[band];
  if (ideal.includes(level)) return "ideal";
  return ideal[ideal.length - 1] === "associate" && level === "professional" ? "stretch" : "adjacent";
}

/* ── credential candidates: researched ∪ field profile, enriched by catalog ── */

/**
 * One credential the model may recommend. It comes from research (`source` =
 * the URL it was found at) or from the field profile (`source` = "model
 * knowledge"). When the catalog recognises it, the catalog's facts — id, level,
 * prep hours, cost — are filled in; otherwise those stay unknown rather than
 * guessed.
 */
export interface CredentialCandidate {
  id: string | null;
  name: string;
  level?: CertLevel;
  prepHours?: [number, number];
  examCostUsd?: number | null;
  marketSignal: string;
  /** The URL it was researched from, or "model knowledge". */
  source: string;
  levelFit?: "ideal" | "stretch" | "adjacent";
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

/**
 * Build the candidate list: researched credentials first (they carry a real
 * source), then the ones the field profile says this field expects. Anything
 * the learner already holds is dropped; duplicates collapse by catalog id or
 * name. The catalog never adds a candidate of its own.
 */
export function buildCredentialCandidates(opts: {
  researched: ResearchSnippet[];
  expected: ProfileCredential[];
  held: Array<{ name: string; catalogId?: string | null }>;
  seniority?: string;
  max?: number;
}): CredentialCandidate[] {
  const heldIds = new Set(opts.held.map((h) => h.catalogId).filter(Boolean));
  const heldNames = new Set(opts.held.map((h) => norm(h.name)));
  const out: CredentialCandidate[] = [];
  const seen = new Set<string>();

  const add = (name: string, marketSignal: string, source: string) => {
    const entry = matchCertification(name);
    const key = entry?.id ?? norm(name);
    if (!key || seen.has(key) || heldNames.has(norm(name)) || (entry && heldIds.has(entry.id))) return;
    seen.add(key);
    if (!entry) {
      out.push({ id: null, name, marketSignal, source });
      return;
    }
    const unmet = (entry.prereqs ?? []).filter((p) => !heldIds.has(p));
    out.push({
      id: entry.id,
      name: entry.name,
      level: entry.level,
      prepHours: entry.prepHours,
      examCostUsd: entry.examCostUsd,
      marketSignal: entry.marketSignal,
      source,
      levelFit: levelFitFor(entry.level, opts.seniority),
      prereqNote: unmet.length ? `Prerequisite first: ${unmet.join(", ")}` : undefined,
    });
  };

  for (const snippet of opts.researched) {
    const name = credentialNameFrom(snippet);
    if (name) add(name, snippet.text.length > 160 ? `${snippet.text.slice(0, 159)}…` : snippet.text, snippet.sourceUrl);
  }
  for (const c of opts.expected) {
    add(c.name, `${c.required ? "Required to practise. " : ""}${c.note}`.trim(), "model knowledge");
  }

  return out.slice(0, opts.max ?? 8);
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
      // Catalog costs are US list prices — say so, or the model reads them as local currency.
      const cost = c.examCostUsd != null ? `US$${c.examCostUsd}` : "cost n/a";
      const extra = c.prereqNote ? ` :: ${c.prereqNote}` : "";
      return `- ${id} :: ${c.name} :: ${level}${fit} :: ${prep} :: ${cost} :: ${c.marketSignal} :: source: ${c.source}${extra}`;
    })
    .join("\n");
}
