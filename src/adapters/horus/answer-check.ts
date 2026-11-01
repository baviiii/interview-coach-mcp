/**
 * Every model answer is checked before a tool sees it, and an unusable one is
 * asked for once more.
 *
 * Unusable means: not JSON we can read; not a JSON object; an error in place
 * of the answer (seen 2026-11-01: {"error": "CRITICAL MISMATCH — cannot
 * proceed"}); or missing a field the tool named in `expect` (seen the same
 * day: the questions' analysis came back and the questions didn't). The
 * second request says what was wrong with the first. If the second answer is
 * still unusable it goes to the tool anyway — each tool already copes with a
 * thin answer the way it did before this check — and the log says so.
 *
 * A retry is a second model call and counts against the learner's plan like
 * any other, so it only happens when the first answer couldn't be used.
 * Failures that aren't about the answer (timeouts, a spent allowance, the
 * upstream erroring) are not retried here: they may already have been spent
 * on, or can't succeed by asking again.
 */

import { UnreadableAnswerError } from "../../errors.js";
import type { InferRequest, InferResult, ModelProvider } from "./port.js";

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** What is wrong with an answer, in words the model can act on; null when it can be used. */
export function answerProblem(data: unknown, expect: readonly string[] = []): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "it was not a JSON object";
  }
  const answer = data as Record<string, unknown>;
  if (!Object.keys(answer).length) return "it was an empty object";
  if (typeof answer.error === "string" && Object.keys(answer).length <= 2 && !expect.some((k) => k in answer)) {
    return `it gave an error ("${answer.error.slice(0, 120)}") instead of doing the task`;
  }
  const missing = expect.filter((k) => isEmpty(answer[k]));
  if (missing.length) return `it was missing ${missing.map((k) => `"${k}"`).join(", ")}`;
  return null;
}

function addUsage(a: InferResult["usage"], b: InferResult["usage"]): InferResult["usage"] {
  if (!a && !b) return undefined;
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  };
}

export function withAnswerCheck(provider: ModelProvider): ModelProvider {
  return {
    infer: async <T>(req: InferRequest): Promise<InferResult<T>> => {
      let first: InferResult<T> | null = null;
      let problem: string | null;
      try {
        first = await provider.infer<T>(req);
        problem = answerProblem(first.data, req.expect);
      } catch (err) {
        if (!(err instanceof UnreadableAnswerError)) throw err;
        problem = "it was not valid JSON";
      }
      if (first && !problem) return first;

      console.warn(`[model] ${req.task}: answer unusable (${problem}); asking once more`);
      const second = await provider.infer<T>({
        ...req,
        system:
          `${req.system}\n\nYOUR PREVIOUS ANSWER TO THIS REQUEST COULD NOT BE USED: ${problem}. ` +
          `Answer again, in full: one JSON object with every field asked for, filled in.`,
      });
      const still = answerProblem(second.data, req.expect);
      if (still) console.warn(`[model] ${req.task}: second answer also unusable (${still}); passing it on`);
      return first ? { ...second, usage: addUsage(first.usage, second.usage) } : second;
    },
    ragSearch: provider.ragSearch?.bind(provider),
    graphQuery: provider.graphQuery?.bind(provider),
  };
}
