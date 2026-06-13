/**
 * GroundingPort — turns model-drafted advice into PROVEN advice by attaching a
 * real, vetted source. The model proposes; grounding proves. Citations come from
 * real data (Reddit threads + upvotes, vetted guides, primary docs) — never
 * invented by the LLM, so a tip is either backed by something real or flagged
 * "unverified".
 *
 * Real implementations compose your existing MCP-client infra to call:
 *   • a Reddit MCP/API   → community proof ("3.2k upvotes")
 *   • a web-search MCP   → external proven resources (Exa / Tavily / Brave)
 *   • Horus RAG          → your curated "proven interview" corpus
 */

export type ProofKind = "reddit" | "resource" | "expert" | "community";

/** Matches the shape the UI's Proof chip renders 1:1. */
export interface ProofSource {
  kind: ProofKind;
  /** Human-readable source name, e.g. "r/cscareerquestions — top thread". */
  label: string;
  /** Credibility signal, e.g. "3.2k upvotes" | "Verified" | "Primary source". */
  stat: string;
  url: string;
}

export interface GroundedResource {
  title: string;
  provider: string;
  type: string; // "Article" | "Course" | "Video" | "Read"
  url?: string;
  why?: string;
  proof: ProofSource;
}

export interface GroundingPort {
  /** Best real source backing a claim/tip, or null if nothing credible is found. */
  findEvidence(req: { claim: string; skill?: string; preferKind?: ProofKind }): Promise<ProofSource | null>;
  /** Candidate resources for a skill/goal, each carrying a proof source. */
  findResources(req: { query: string; skills: string[]; max?: number }): Promise<GroundedResource[]>;
}
