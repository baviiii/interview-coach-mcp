import { config } from "../../config.js";
import { HttpGrounding } from "./http-client.js";
import { HackerNewsGrounding } from "./hackernews-client.js";
import { MockGrounding } from "./mock-client.js";
import { RedditGrounding } from "./reddit-client.js";
import type { GroundingPort } from "./port.js";

export * from "./port.js";

let singleton: GroundingPort | null = null;

/** Resolves the grounding implementation from env. mock by default. */
export function getGrounding(): GroundingPort {
  if (singleton) return singleton;

  if (config.grounding.mode === "hn") {
    singleton = new HackerNewsGrounding();
  } else if (config.grounding.mode === "reddit") {
    singleton = new RedditGrounding();
  } else if (config.grounding.mode === "http") {
    if (!config.grounding.baseUrl) {
      throw new Error("GROUNDING_MODE=http requires GROUNDING_BASE_URL");
    }
    singleton = new HttpGrounding({
      baseUrl: config.grounding.baseUrl,
      apiKey: config.grounding.apiKey,
      tenant: config.horus.tenant,
    });
  } else {
    singleton = new MockGrounding();
  }
  return singleton;
}
