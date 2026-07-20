import type { ResearchKind, ResearchRequest, ResearchSnippet } from "./port.js";
import { redditUrl, searchReddit, type RedditPost } from "./reddit-fetch.js";
import type { ResearchSource } from "./source.js";
import { fmtCount, truncate } from "./util.js";

/**
 * The workhorse source — real accounts from people in the field. This is the
 * "grounded like Reddit users who had issues" promise: for ANY field it pulls
 * the threads where people describe their interviews, what got asked, and where
 * they struggled. One templated query per requested intent (so a questions tool
 * fires ~2 calls, not 4), each result tagged with its real permalink + upvotes.
 */

type RedditIntent = Exclude<ResearchKind, "fact">;

const QUERIES: Record<RedditIntent, (field: string, role?: string) => string> = {
  question: (f, r) => `${r ?? f} interview questions`,
  experience: (f, r) => `${r ?? f} interview experience struggled OR failed OR mistake`,
  credential: (f) => `${f} certification OR license OR exam worth it`,
  resource: (f) => `best ${f} course OR book OR study resource`,
};

const ALL_INTENTS: RedditIntent[] = ["question", "experience", "credential", "resource"];

export class RedditResearchSource implements ResearchSource {
  readonly name = "Reddit";

  async gather(req: ResearchRequest): Promise<ResearchSnippet[]> {
    const intents = (req.intents ?? ALL_INTENTS).filter((i): i is RedditIntent => i !== "fact");
    const perQuery = Math.max(2, Math.min(req.max ?? 4, 6));

    const lists = await Promise.all(
      intents.map(async (kind) => {
        const posts = await searchReddit(QUERIES[kind](req.field, req.role), perQuery + 3);
        return posts
          .filter((p) => (p.ups ?? 0) >= 5)
          .slice(0, perQuery)
          .map((p) => toSnippet(kind, p));
      }),
    );
    return lists.flat();
  }
}

function toSnippet(kind: RedditIntent, p: RedditPost): ResearchSnippet {
  const body = p.selftext?.trim() ? ` — ${truncate(p.selftext, 200)}` : "";
  return {
    kind,
    text: `${truncate(p.title, 140)}${body}`,
    sourceUrl: redditUrl(p),
    sourceLabel: `r/${p.subreddit}`,
    stat: `${fmtCount(p.ups)} upvotes`,
  };
}
