import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerResources } from "../resources/index.js";
import { registerAnalyticsTools } from "../tools/analytics.js";
import { registerCareerTools } from "../tools/career.js";
import { registerInterviewTools, type ToolDeps } from "../tools/interview.js";
import { registerLearningTools } from "../tools/learning.js";
import { registerProfileTools } from "../tools/profile.js";
import { registerProofTools } from "../tools/proof.js";
import { registerStudyTools } from "../tools/study.js";

/**
 * Builds a fully-wired MCP server for ONE authenticated request (stateless).
 * Tools/resources close over the per-request auth + Horus + grounding deps —
 * no shared mutable state, identity baked in from the verified JWT.
 */
export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "interview-coach-mcp", version: "0.2.0" });
  registerInterviewTools(server, deps);
  registerCareerTools(server, deps);
  registerStudyTools(server, deps);
  registerProfileTools(server, deps);
  registerLearningTools(server, deps);
  registerProofTools(server, deps);
  registerAnalyticsTools(server, deps);
  registerResources(server, deps);
  return server;
}
