import type { ResearchRequest, ResearchSnippet } from "./port.js";

/**
 * Internal seam: one upstream the composite can fan out to. Each source returns
 * a flat list of kind-tagged, source-carrying snippets and MUST NOT throw
 * (catch internally, return []). The composite buckets, dedupes and caps.
 */
export interface ResearchSource {
  readonly name: string;
  gather(req: ResearchRequest): Promise<ResearchSnippet[]>;
}
