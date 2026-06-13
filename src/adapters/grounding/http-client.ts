import { UpstreamError } from "../../errors.js";
import type { GroundedResource, GroundingPort, ProofKind, ProofSource } from "./port.js";

export interface HttpGroundingConfig {
  baseUrl: string;
  apiKey?: string;
  tenant: string;
}

/**
 * Talks to a grounding service that fronts your real sources. In practice that
 * service is a thin bridge which is itself an MCP *client* of a Reddit MCP + a
 * web-search MCP (Exa/Tavily) + Horus RAG — exactly the "use other MCP
 * connectivity" composition. Expected endpoints:
 *
 *   POST {baseUrl}/evidence   { claim, skill?, preferKind? } -> { proof: ProofSource | null }
 *   POST {baseUrl}/resources  { query, skills, max? }        -> { resources: GroundedResource[] }
 *
 * Until that bridge is deployed, run GROUNDING_MODE=mock.
 */
export class HttpGrounding implements GroundingPort {
  constructor(private readonly cfg: HttpGroundingConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", "x-tenant": this.cfg.tenant };
    if (this.cfg.apiKey) h["Authorization"] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private async post<R>(path: string, body: unknown): Promise<R> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    } catch (e) {
      throw new UpstreamError(`Grounding request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new UpstreamError(`Grounding ${res.status}: ${t.slice(0, 200)}`);
    }
    return (await res.json()) as R;
  }

  async findEvidence(req: { claim: string; skill?: string; preferKind?: ProofKind }): Promise<ProofSource | null> {
    const out = await this.post<{ proof?: ProofSource | null }>("/evidence", { ...req, tenant: this.cfg.tenant });
    return out.proof ?? null;
  }

  async findResources(req: { query: string; skills: string[]; max?: number }): Promise<GroundedResource[]> {
    const out = await this.post<{ resources?: GroundedResource[] }>("/resources", { ...req, tenant: this.cfg.tenant });
    return out.resources ?? [];
  }
}
