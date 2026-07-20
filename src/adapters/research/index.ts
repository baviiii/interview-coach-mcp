import { config } from "../../config.js";
import { getModelProvider } from "../horus/index.js";
import { CompositeResearch } from "./composite.js";
import { HackerNewsResearchSource } from "./hackernews-research.js";
import { HorusRagResearchSource } from "./horus-rag-research.js";
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
      // auto — every free source. Horus RAG self-disables when the provider has
      // no ragSearch (mock / plain gateway), so this is safe in all modes.
      singleton = new CompositeResearch([
        new RedditResearchSource(),
        new HackerNewsResearchSource(),
        new WikipediaResearchSource(),
        new HorusRagResearchSource(getModelProvider()),
      ]);
  }
  return singleton;
}
