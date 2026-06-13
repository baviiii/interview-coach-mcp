import type { GroundedResource, GroundingPort, ProofKind, ProofSource } from "./port.js";

/** Deterministic offline grounding so the whole server runs with no external
 *  sources (GROUNDING_MODE=mock). Swap for HttpGrounding to hit real sources. */
const TIP_SOURCES: ProofSource[] = [
  { kind: "reddit", label: "r/cscareerquestions — top-voted thread", stat: "3.2k upvotes", url: "https://reddit.com/r/cscareerquestions" },
  { kind: "expert", label: "Ex-FAANG staff engineer AMA", stat: "Verified", url: "https://reddit.com/r/ExperiencedDevs" },
  { kind: "resource", label: "Hello Interview — System Design in a Hurry", stat: "Proven framework", url: "https://www.hellointerview.com/" },
  { kind: "community", label: "Blind — onsite prep megathread", stat: "Community favorite", url: "https://www.teamblind.com/" },
];

export class MockGrounding implements GroundingPort {
  async findEvidence(req: { claim: string; skill?: string; preferKind?: ProofKind }): Promise<ProofSource | null> {
    if (req.preferKind) {
      const match = TIP_SOURCES.find((s) => s.kind === req.preferKind);
      if (match) return match;
    }
    // Deterministic pick so the same tip always cites the same source.
    return TIP_SOURCES[req.claim.length % TIP_SOURCES.length] ?? null;
  }

  async findResources(req: { query: string; skills: string[]; max?: number }): Promise<GroundedResource[]> {
    const all: GroundedResource[] = [
      {
        title: "Designing Data-Intensive Applications — Ch. 7 (Transactions)",
        provider: "Book", type: "Read",
        url: "https://dataintensive.net/",
        why: `Directly targets ${req.skills[0] ?? "your weakest skill"}.`,
        proof: { kind: "reddit", label: "r/ExperiencedDevs most-recommended", stat: "1.8k upvotes", url: "https://reddit.com/r/ExperiencedDevs" },
      },
      {
        title: "Grokking the System Design Interview",
        provider: "DesignGurus", type: "Course",
        url: "https://www.designgurus.io/",
        why: "Structured reps for the round you're weakest in.",
        proof: { kind: "community", label: "Blind — top onsite pick", stat: "Community favorite", url: "https://www.teamblind.com/" },
      },
      {
        title: "Idempotency keys, explained with a real payments API",
        provider: "Stripe Docs", type: "Article",
        url: "https://stripe.com/docs/api/idempotent_requests",
        why: "Primary source — mirrors how your target frames the problem.",
        proof: { kind: "resource", label: "Official engineering docs", stat: "Primary source", url: "https://stripe.com/docs" },
      },
    ];
    return all.slice(0, req.max ?? 5);
  }
}
