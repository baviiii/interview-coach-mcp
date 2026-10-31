import { QuotaError, UpstreamError } from "../../errors.js";
import type {
  GraphQueryRequest,
  GraphResult,
  HorusPort,
  InferRequest,
  InferResult,
  RagSearchRequest,
  RagSearchResult,
} from "./port.js";

/** One call plus up to two retries when the upstream had no worker to run it on. */
export const MAX_ATTEMPTS = 3;

/**
 * How long to wait before trying again, or null when the response mustn't be
 * retried.
 *
 * Only Supabase Edge Functions' BOOT_ERROR is retried. It means no worker
 * started for the request, so the function never ran: nothing was spent, no
 * quota was used, and sending it again is safe. It happens when several long
 * model calls arrive together, because each holds a worker for its whole
 * duration and the platform won't start more (seen 2026-10-31 on CareerCraft's
 * infer: three parallel calls, one or two refused after ~10 s while the others
 * succeeded). Waiting a moment lets a worker free up. Any other failure may
 * have run the call and spent on it, so it is never retried here.
 */
export function retryDelay(status: number, body: string, attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS || status !== 503 || !/"code"\s*:\s*"BOOT_ERROR"/.test(body)) return null;
  // 1–1.5 s, then 3–3.5 s; jittered so refused calls don't come back in step.
  return (attempt === 1 ? 1000 : 3000) + Math.floor(Math.random() * 500);
}

export interface HttpHorusConfig {
  baseUrl: string;
  apiKey?: string;
  /** Defaults to `${baseUrl}/rag-metadata` (today's Horus semantic-search). */
  ragUrl?: string;
  /** Defaults to `${baseUrl}/graph-query`. */
  graphUrl?: string;
  tenant: string;
  /** Hard cap per request — a hung upstream otherwise hangs the tool call forever. */
  timeoutMs?: number;
}

/**
 * Talks to a real Horus deployment.
 *
 * `ragSearch` and `graphQuery` map directly onto endpoints Horus exposes today
 * (the `@horus/sdk` `semanticSearch` / graph-query surface). `infer` targets a
 * first-class generation endpoint (`POST /infer`) that Horus should expose so
 * that ALL model connectivity lives behind Horus. Until that ships you can
 * point HORUS_BASE_URL at a shim, or flip HORUS_MODE=mock.
 */
export class HttpHorusClient implements HorusPort {
  constructor(private readonly cfg: HttpHorusConfig) {}

  /**
   * @param userToken The end user's own credential, when one is available.
   *
   * It travels as `x-user-token` rather than in `Authorization`, because that
   * header already carries this server's API key and the upstream needs both:
   * the key says which tenant is calling, the user token says on whose behalf.
   * Collapsing them into one header would force the upstream to guess.
   */
  private headers(userToken?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tenant": this.cfg.tenant,
    };
    if (this.cfg.apiKey) {
      h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
      h["x-functions-key"] = this.cfg.apiKey; // Azure Functions compatibility
    }
    if (userToken) {
      h["x-user-token"] = userToken;
    }
    return h;
  }

  private async post<R>(url: string, body: unknown, userToken?: string): Promise<R> {
    const timeoutMs = this.cfg.timeoutMs ?? 60_000;
    let res: Response;
    let text = "";
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: this.headers(userToken),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new UpstreamError(`Horus timed out after ${timeoutMs}ms`);
        }
        throw new UpstreamError(`Horus request failed: ${(err as Error).message}`);
      }
      if (res.ok) break;
      text = await res.text().catch(() => "");
      const wait = retryDelay(res.status, text, attempt);
      if (wait === null) break;
      console.warn(`[horus] ${url} had no worker to run on (BOOT_ERROR); retrying in ${wait}ms (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (!res.ok) {
      // A spent allowance is an answer, not an outage. Pass it through with its
      // status and body intact so the browser can explain the limit; folding it
      // into a 502 would tell the user to retry, which cannot work.
      if (res.status === 429) {
        let details: unknown;
        let message = "Usage limit reached";
        try {
          const body = JSON.parse(text) as { error?: string; details?: unknown };
          if (body.error) message = body.error;
          details = body.details;
        } catch {
          // Non-JSON 429 — the status alone still tells us enough.
        }
        throw new QuotaError(message, details);
      }

      throw new UpstreamError(`Horus ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as R;
  }

  async infer<T = unknown>(req: InferRequest): Promise<InferResult<T>> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/infer`;
    const out = await this.post<{
      content?: string;
      output?: string;
      model?: string;
      cached?: boolean;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>(url, {
      task: req.task,
      system: req.system,
      messages: req.messages,
      schema: req.schema,
      schemaName: req.schemaName,
      model: req.model ?? "fast",
      temperature: req.temperature ?? 0.7,
      maxTokens: req.maxTokens ?? 4000,
      tenant: this.cfg.tenant,
      userRef: req.userRef,
    }, req.userToken);

    const raw = out.content ?? out.output ?? "";
    return {
      data: parseJson<T>(raw),
      raw,
      model: out.model ?? "unknown",
      cached: out.cached ?? false,
      usage: out.usage,
    };
  }

  async ragSearch(req: RagSearchRequest): Promise<RagSearchResult> {
    const url = this.cfg.ragUrl ?? `${this.cfg.baseUrl.replace(/\/$/, "")}/rag-metadata`;
    const out = await this.post<{
      success?: boolean;
      data?: { answer?: string; sources?: RawSource[] };
      answer?: string;
      sources?: RawSource[];
    }>(url, {
      type: "semantic-search",
      query: req.query,
      filters: req.filters ?? {},
      options: { topK: req.topK ?? 20, timeAwareRanking: true, systemPrompt: req.systemPrompt },
    });

    const payload = out.data ?? out;
    const sources = payload.sources ?? [];
    return {
      answer: payload.answer,
      passages: sources.map((s) => ({
        text: s.content ?? "",
        title: s.title,
        source: s.documentId ?? s.id ?? "unknown",
        score: typeof s.score === "number" ? s.score : 0,
        url: s.url,
      })),
    };
  }

  async graphQuery(req: GraphQueryRequest): Promise<GraphResult> {
    const url = this.cfg.graphUrl ?? `${this.cfg.baseUrl.replace(/\/$/, "")}/graph-query`;
    const action = req.kind === "traverse" ? "traverse" : "search";
    const out = await this.post<{ data?: Array<Record<string, unknown>> }>(url, {
      action,
      backend: "cosmos",
      ...req.params,
    });
    return { nodes: out.data ?? [], raw: out };
  }
}

interface RawSource {
  id?: string;
  documentId?: string;
  content?: string;
  title?: string;
  url?: string;
  score?: number;
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
    throw new UpstreamError("Horus returned non-JSON content");
  }
}
