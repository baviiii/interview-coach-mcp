import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  emptyResearch,
  researchSources,
  type FieldResearch,
  type ResearchPort,
  type ResearchRequest,
} from "../adapters/research/index.js";
import type { GroundingPort, ProofSource } from "../adapters/grounding/index.js";
import type { ResearchSnippet } from "../adapters/research/port.js";
import { config } from "../config.js";
import type { FieldProfile } from "../domain/field-profile.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Run live research best-effort. The port is already non-throwing by contract,
 * but this guarantees a tool never breaks because research did — it degrades to
 * an empty (partial) bundle, and the prompt simply omits the signals block.
 */
export async function researchSafely(research: ResearchPort, req: ResearchRequest): Promise<FieldResearch> {
  try {
    return await research.researchField({ ...req, market: req.market ?? config.market });
  } catch {
    return emptyResearch(req.field ?? "", req.role, true);
  }
}

/** Compact research provenance for a tool's `_meta` (which real sources backed it). */
export function researchMeta(r: FieldResearch): { sources: string[]; partial: boolean } {
  return { sources: researchSources(r), partial: r.partial };
}

/**
 * Why a result is thinner than it should be. Empty output and broken output
 * look identical from the UI ("the learning pathway doesn't work"), so every
 * pathway tool reports what degraded instead of silently returning nothing.
 */
export interface Degradation {
  degraded: boolean;
  reasons: string[];
}

export function degradation(reasons: Array<string | false | null | undefined>): Degradation {
  const kept = reasons.filter((r): r is string => typeof r === "string" && r.length > 0);
  return { degraded: kept.length > 0, reasons: kept };
}

export function err(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** score_history.overall_score is DECIMAL(4,2) → max 99.99. */
export function clampScore(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Math.max(0, Math.min(99.99, n));
}

/** A field profile at or above this is technical enough for a tech-only proof source. */
export const TECH_PROOF_MIN_WEIGHT = 0.6;

/**
 * Whether this proof source's links fit the field. A tech-only source (Hacker
 * News) is used only for technical fields: under a nurse's or a chef's tip its
 * links are off-topic, and no link (the tip says "unverified") beats a wrong
 * one. A field whose profile couldn't be worked out counts as not technical.
 */
export function groundingFits(grounding: GroundingPort, profile: Pick<FieldProfile, "technicalWeight">): boolean {
  return !grounding.techOnly || profile.technicalWeight >= TECH_PROOF_MIN_WEIGHT;
}

/** A research snippet as a proof chip: the real post or page it came from. */
export function proofFromSnippet(s: ResearchSnippet): ProofSource {
  return {
    kind: s.sourceLabel.startsWith("r/") || /reddit\.com/.test(s.sourceUrl) ? "reddit" : "community",
    label: s.sourceLabel,
    stat: s.stat ?? "Real post",
    url: s.sourceUrl,
  };
}
