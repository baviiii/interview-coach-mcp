import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
