import { UpstreamError } from "../../errors.js";
import type {
  InferRequest,
  InferResult,
  ModelProvider,
} from "./port.js";

export interface GatewayConfig {
  /** Chat-completions endpoint, e.g. https://ai.gateway.lovable.dev/v1/chat/completions */
  url: string;
  /** Bearer key for the gateway (your existing LOVABLE_API_KEY). */
  apiKey: string;
  /** Model id for the "fast" capability tier. */
  fast: string;
  /** Model id for the "deep" capability tier. */
  deep: string;
  /** Hard cap per request — a hung gateway otherwise hangs the tool call forever. */
  timeoutMs?: number;
}

/**
 * GatewayModelProvider — a real ModelProvider that talks to an OpenAI-compatible
 * chat-completions gateway (the same gateway the careercraft `interview-ai` edge
 * function uses). This is the turnkey seam the README describes: implement
 * `ModelProvider` against your own LLM and swap it in `./index.ts`. No mock.
 *
 * `model: "fast" | "deep"` is a capability tier — we map it to concrete model
 * ids the gateway understands, so the rest of the server stays vendor-agnostic.
 */
export class GatewayModelProvider implements ModelProvider {
  constructor(private readonly cfg: GatewayConfig) {}

  async infer<T = unknown>(req: InferRequest): Promise<InferResult<T>> {
    const model = req.model === "deep" ? this.cfg.deep : this.cfg.fast;

    const timeoutMs = this.cfg.timeoutMs ?? 60_000;
    let res: Response;
    try {
      res = await fetch(this.cfg.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: req.system },
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          response_format: { type: "json_object" },
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 4000,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new UpstreamError(`Gateway timed out after ${timeoutMs}ms`);
      }
      throw new UpstreamError(`Gateway request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 429) throw new UpstreamError("Gateway rate limit exceeded");
      if (res.status === 402) throw new UpstreamError("Gateway credits exhausted");
      throw new UpstreamError(`Gateway ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    if (!raw) throw new UpstreamError("Gateway returned an empty response");

    return {
      data: parseJson<T>(raw),
      raw,
      model: json.model ?? model,
      cached: false,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
    };
  }
}

/** Tolerant JSON parse: strips ```json fences and trailing prose. */
function parseJson<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new UpstreamError("Gateway returned non-JSON content");
  }
}
