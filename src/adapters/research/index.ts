import { config } from "../../config.js";
import { CompositeResearch } from "./composite.js";
import { HackerNewsResearchSource } from "./hackernews-research.js";
import { KnowledgeIndexResearchSource } from "./knowledge-index.js";
import { MockResearch } from "./mock-client.js";
import { emptyResearch, type ResearchPort, type ResearchRequest } from "./port.js";
import { RedditResearchSource } from "./reddit-research.js";
import { WikipediaResearchSource } from "./wikipedia-client.js";

export * from "./port.js";

/** RESEARCH_MODE=off — research disabled; tools fall back to pre-research output. */
class NullResearch implements ResearchPort {
  async researchField(req: ResearchRequest) {
    return emptyResearch(req.field ?? "", req.role);
  }
}

let singleton: ResearchPort | null = null;

/**
 * CareerCraft's horus-rag function: HORUS_KNOWLEDGE_URL, or next to /infer on
 * the same functions URL. Null without either, and the source sits out.
 */
export function knowledgeIndexUrl(): string | null {
  if (config.horus.knowledgeUrl) return config.horus.knowledgeUrl;
  return config.horus.baseUrl ? `${config.horus.baseUrl.replace(/\/$/, "")}/horus-rag` : null;
}

/** Resolves the research implementation from env. `auto` (all free sources) by
 *  default. Mirrors getGrounding() / getModelProvider(). */
export function getResearch(): ResearchPort {
  if (singleton) return singleton;

  switch (config.research.mode) {
    case "off":
      singleton = new NullResearch();
      break;
    case "mock":
      singleton = new MockResearch();
      break;
    case "reddit":
      singleton = new CompositeResearch([new RedditResearchSource()]);
      break;
    default:
      // auto — every free source. The knowledge index sits out unless a tool
      // asks for it and the learner is signed in (see knowledge-index.ts).
      // It goes first: buckets fill in this order and are capped, and curated
      // Australian documents are the most trustworthy thing here.
      singleton = new CompositeResearch([
        new KnowledgeIndexResearchSource({
          url: knowledgeIndexUrl(),
          anonKey: config.supabase.anonKey,
        }),
        new RedditResearchSource(),
        new HackerNewsResearchSource(),
        new WikipediaResearchSource(),
      ]);
  }
  return singleton;
}
