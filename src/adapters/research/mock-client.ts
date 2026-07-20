import { type FieldResearch, type ResearchPort, type ResearchRequest } from "./port.js";

/**
 * Deterministic offline research (RESEARCH_MODE=mock) so the whole server runs
 * end-to-end with no network — and so smoke/dev exercises the same "REAL-WORLD
 * SIGNALS" prompt path that live mode uses. Field-templated so the canned output
 * still looks plausible for whatever field is passed.
 */
export class MockResearch implements ResearchPort {
  async researchField(req: ResearchRequest): Promise<FieldResearch> {
    const f = req.field?.trim() || "the field";
    const role = req.role ?? f;
    return {
      field: f,
      role: req.role,
      questions: [
        {
          kind: "question",
          text: `"Walk me through a hard ${f} situation and exactly how you handled it." — the recurring panel opener.`,
          sourceUrl: "https://www.reddit.com/r/mockfield/comments/q1/",
          sourceLabel: "r/mockfield",
          stat: "1.2k upvotes",
        },
        {
          kind: "question",
          text: `Screen for ${role}: expect scenario/judgment questions about day-to-day calls, not trivia.`,
          sourceUrl: "https://www.reddit.com/r/mockfield/comments/q2/",
          sourceLabel: "r/mockfield",
          stat: "640 upvotes",
        },
      ],
      experiences: [
        {
          kind: "experience",
          text: `Froze on "why do you want to work here" and under-prepared STAR follow-ups — biggest reported miss.`,
          sourceUrl: "https://www.reddit.com/r/mockfield/comments/e1/",
          sourceLabel: "r/mockfield",
          stat: "880 upvotes",
        },
      ],
      credentials: [
        {
          kind: "credential",
          text: `Most ${f} postings expect the field's standard entry license/credential before they interview you.`,
          sourceUrl: "https://en.wikipedia.org/wiki/Professional_certification",
          sourceLabel: "Wikipedia",
        },
      ],
      resources: [
        {
          kind: "resource",
          text: `Community-recommended prep guide for ${f} interviews.`,
          sourceUrl: "https://www.reddit.com/r/mockfield/comments/r1/",
          sourceLabel: "r/mockfield",
          stat: "2.1k upvotes",
        },
      ],
      facts: [
        {
          kind: "fact",
          text: `${f}: overview of the role's core responsibilities and typical entry requirements.`,
          sourceUrl: "https://en.wikipedia.org/wiki/Occupation",
          sourceLabel: "Wikipedia",
        },
      ],
      partial: false,
      fetchedAt: Date.now(),
    };
  }
}
