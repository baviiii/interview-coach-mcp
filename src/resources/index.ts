import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { CERT_CATALOG } from "../domain/certifications.js";
import type { ToolDeps } from "../tools/interview.js";

/** Read-only MCP Resources: context a host/model can pull without a tool call. */
export function registerResources(server: McpServer, deps: ToolDeps): void {
  const { auth } = deps;

  server.registerResource(
    "user_context_summary",
    "careercraft://learner/context",
    {
      title: "Learner context summary",
      description: "Persona, target role, skill matrix, weak areas, recent scores.",
      mimeType: "application/json",
    },
    async (uri) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx, null, 2) }],
      };
    },
  );

  server.registerResource(
    "last_interview_gaps",
    "careercraft://learner/gaps",
    {
      title: "Latest interview gaps",
      description: "The learner's current weak skills and weakest question type.",
      mimeType: "application/json",
    },
    async (uri) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const gaps = {
        weakSkills: ctx.weakSkills,
        weakestQuestionType: ctx.patterns?.weakestQuestionType ?? null,
        recentOverallScores: ctx.recentOverallScores,
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(gaps, null, 2) }],
      };
    },
  );

  server.registerResource(
    "learner_certifications",
    "careercraft://learner/certifications",
    {
      title: "Learner certifications",
      description: "Certifications held, with expiry status and the skills each one vouches for.",
      mimeType: "application/json",
    },
    async (uri) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const payload = {
        certifications: ctx.certifications,
        expiringSoon: ctx.certifications.filter((c) => c.status === "expiring_soon").map((c) => c.name),
        expired: ctx.certifications.filter((c) => c.status === "expired").map((c) => c.name),
        certifiedSkills: [...new Set(ctx.certifications.flatMap((c) => c.skills ?? []))],
      };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  server.registerResource(
    "career_profile",
    "careercraft://learner/career-profile",
    {
      title: "Full career profile",
      description:
        "The complete picture: goal, skill matrix, certifications, scores, practice patterns, job pipeline, resume signal, persona.",
      mimeType: "application/json",
    },
    async (uri) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx, null, 2) }],
      };
    },
  );

  server.registerResource(
    "certification_catalog",
    "careercraft://catalog/certifications",
    {
      title: "Curated certification catalog",
      description:
        "Reference facts (issuer, level, skills vouched for, prep hours, cost, validity, market signal) for the certifications the catalog knows. Used to enrich cert advice with cost and effort, never to decide what to suggest.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(CERT_CATALOG, null, 2) }],
    }),
  );
}
