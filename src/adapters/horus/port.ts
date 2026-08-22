/**
 * ModelProvider — the ONLY way this server reaches a model. This is the
 * sale/turnkey seam: the interview brain depends on this interface, not on any
 * vendor. **Horus is the default adapter**, but a buyer ships turnkey by
 * implementing `ModelProvider` against their own LLM (OpenAI, Anthropic, a
 * gateway) and swapping it in `./index.ts`.
 *
 * `infer()` is the only required method — the interview core runs on generation
 * alone. `ragSearch()`/`graphQuery()` are optional Horus-specific enhancements
 * (retrieval + knowledge graph); a plain LLM adapter omits them.
 *
 * `model: "fast" | "deep"` is a capability tier, not a vendor model id — so the
 * provider owns routing.
 */

export interface InferMessage {
  role: "user" | "assistant";
  content: string;
}

export interface InferRequest {
  /** Routing + telemetry key, e.g. "interview.evaluate_answer". */
  task: string;
  /** Expert system prompt (the domain moat). */
  system: string;
  messages: InferMessage[];
  /** JSON Schema the response must satisfy. Provider enforces; we still validate. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  model?: "fast" | "deep";
  temperature?: number;
  maxTokens?: number;
  /** For per-user cost attribution. */
  userRef?: string;
  /**
   * The end user's own credential, for a provider that meters per user.
   *
   * Distinct from `userRef`, and the distinction is the point: `userRef` is a
   * label the provider has to take on trust, while this is something it can
   * verify for itself. A provider that can check it may apply that user's real
   * plan and limits rather than treating every request from this server as one
   * anonymous caller.
   *
   * Opaque on purpose — this interface is the vendor-neutral seam, so it says
   * "a token the provider understands" and not "a Supabase JWT". Adapters that
   * have no use for it ignore it.
   */
  userToken?: string;
}

export interface InferResult<T = unknown> {
  data: T;
  raw: string;
  model: string;
  cached: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface RagPassage {
  text: string;
  title?: string;
  source: string;
  score: number;
  url?: string;
}

export interface RagSearchRequest {
  query: string;
  corpus?: "interview-guides" | "role-competencies" | "company-patterns" | "careers";
  filters?: Record<string, unknown>;
  topK?: number;
  systemPrompt?: string;
}

export interface RagSearchResult {
  answer?: string;
  passages: RagPassage[];
}

export interface GraphQueryRequest {
  kind: "role_skills" | "skill_prereqs" | "skill_resources" | "search" | "traverse";
  params: Record<string, unknown>;
}

export interface GraphResult {
  nodes: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  raw?: unknown;
}

export interface ModelProvider {
  /** Structured generation. Returns parsed JSON of type T. REQUIRED. */
  infer<T = unknown>(req: InferRequest): Promise<InferResult<T>>;
  /** Retrieval over a corpus (Horus maps this to rag-metadata). OPTIONAL. */
  ragSearch?(req: RagSearchRequest): Promise<RagSearchResult>;
  /** Skill/role/resource graph (Horus maps this to graph-query). OPTIONAL. */
  graphQuery?(req: GraphQueryRequest): Promise<GraphResult>;
}

/** @deprecated Horus is one implementation of {@link ModelProvider}. Use ModelProvider. */
export type HorusPort = ModelProvider;
