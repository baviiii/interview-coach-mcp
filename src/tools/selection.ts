import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { readStoryTexts } from "../context/interview-store.js";
import { competencyLabel } from "../domain/competencies.js";
import { selectionCriterionPrompt } from "../domain/prompts.js";
import * as S from "../schemas.js";
import { err, ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

const DEFAULT_WORD_LIMIT = 300;

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Selection criteria: a written STAR response to one criterion, drafted from
 * the learner's own story library. The word count and the over-limit check
 * are ours — the model is bad at counting, and a response over the limit can
 * be marked down or not read at all.
 */
export function registerSelectionTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus } = deps;

  server.registerTool(
    "draft_selection_criterion",
    {
      title: "Draft a selection criterion response",
      description:
        "Writes a first-person STAR response to one key selection criterion from the learner's own saved stories and résumé, within a word limit. Never invents facts; says what's missing instead.",
      inputSchema: S.selectionCriterionInput,
    },
    async (args) => {
      const wordLimit = args.wordLimit ?? DEFAULT_WORD_LIMIT;
      const [ctx, allStories] = await Promise.all([
        assembleLearnerContext(auth.db, auth.userId, {}),
        readStoryTexts(auth.db, auth.userId),
      ]);
      const stories = (args.competency ? allStories.filter((s) => s.competency === args.competency) : allStories)
        .filter((s) => s.answer.trim())
        .map((s) => ({ ...s, label: competencyLabel(s.competency, ctx.targetSeniority) }));
      if (args.competency && stories.length === 0) {
        return err("There's no saved story for that competency yet. Practise it first, then draft from it.");
      }

      const { system, user } = selectionCriterionPrompt({
        criterion: args.criterion,
        wordLimit,
        stories,
        jobDescription: args.jobDescription,
        framework: args.framework,
        frameworkLevel: args.frameworkLevel,
        ctx,
      });
      const res = await horus.infer<{
        draft?: unknown;
        storyUsed?: unknown;
        starCoverage?: unknown;
        gaps?: unknown;
        tips?: unknown;
      }>({
        task: "interview.selection_criterion",
        expect: ["draft"],
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        temperature: 0.4,
        userRef: auth.userId,
        userToken: auth.jwt,
      });

      const draft = typeof res.data.draft === "string" ? res.data.draft.trim() : "";
      const used = stories.find((s) => s.competency === res.data.storyUsed);
      const words = wordCount(draft);
      const list = (v: unknown) =>
        (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 5);

      return ok({
        draft,
        wordCount: words,
        wordLimit,
        overLimit: words > wordLimit,
        storyUsed: used ? { competency: used.competency, label: used.label, title: used.title } : null,
        starCoverage: res.data.starCoverage ?? null,
        gaps: list(res.data.gaps),
        tips: list(res.data.tips),
        storiesAvailable: stories.length,
        _meta: { model: res.model },
      });
    },
  );
}
