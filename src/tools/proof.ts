import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import * as S from "../schemas.js";
import { ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * proof.* — the grounding layer. Every tip/resource it returns carries a real,
 * vetted source (or is flagged unverified). This is the "backed by Reddit /
 * proven resources" promise, made into tool output the UI renders directly.
 */
export function registerProofTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus, grounding } = deps;

  // ── get_proven_tips ─────────────────────────────────────────────────────
  server.registerTool(
    "get_proven_tips",
    {
      title: "Get proven, source-backed tips",
      description:
        "Drafts sharp tips for a skill/question, then attaches a REAL vetted source (Reddit thread, proven guide) to each. Tips with no credible source are flagged unverified.",
      inputSchema: S.provenTipsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const focus = args.skill ?? ctx.weakSkills[0]?.name ?? "interview performance";
      const count = args.count ?? 3;

      const system = `You are an elite interview coach. Draft ${count} sharp, specific, NON-generic tips for the focus area. Each tip is one actionable sentence. Return ONLY JSON: { "tips": string[] }.`;
      const user = `FOCUS: ${focus}\n${args.question ? `QUESTION: ${args.question}\n` : ""}Avoid platitudes — give tactics an experienced interviewer would respect.`;

      const draft = await horus.infer<{ tips?: string[] }>({
        task: "proof.draft_tips",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
      });

      const tips = Array.isArray(draft.data.tips) ? draft.data.tips.slice(0, count) : [];
      const grounded = await Promise.all(
        tips.map(async (tip) => {
          let proof = null;
          try {
            proof = await grounding.findEvidence({ claim: tip, skill: focus });
          } catch {
            /* grounding best-effort — unverified tips are still returned, labeled */
          }
          return { tip, proof, verified: proof !== null };
        }),
      );

      return ok({ focus, tips: grounded, _meta: { model: draft.model } });
    },
  );

  // ── find_proven_resources ───────────────────────────────────────────────
  server.registerTool(
    "find_proven_resources",
    {
      title: "Find proven, source-backed resources",
      description:
        "Returns learning resources for the learner's weak skills / goal, each backed by a real source (community recommendation, primary doc).",
      inputSchema: S.provenResourcesInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const skills = args.skills ?? ctx.weakSkills.map((s) => s.name);
      const query = args.goal ?? `interview prep resources for ${skills[0] ?? "your target role"}`;

      let resources: Awaited<ReturnType<typeof grounding.findResources>> = [];
      try {
        resources = await grounding.findResources({ query, skills, max: args.maxResults ?? 6 });
      } catch {
        /* best-effort */
      }

      return ok({ query, skills, resources });
    },
  );
}
