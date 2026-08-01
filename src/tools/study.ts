import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { assembleLearnerContext } from "../context/assemble.js";
import { persistSkillSignal, persistSkillSignals } from "../context/persist.js";
import { drillPrompt, explainConceptPrompt, studyPlanPrompt } from "../domain/prompts.js";
import {
  drillDifficulty,
  nextReviewInDays,
  pickDrillSkill,
  proficiencyNudge,
} from "../domain/spaced-repetition.js";
import { deriveSkillTargets } from "../domain/targets.js";
import * as S from "../schemas.js";
import { degradation, err, ok, researchMeta, researchSafely } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * study.* — the upskilling engine. Deterministic scheduling (spaced repetition
 * over the real skill matrix) decides WHAT and WHEN; the model writes the
 * content; results write back so the matrix stays honest.
 */
export function registerStudyTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus, grounding } = deps;

  // ── build_study_plan ────────────────────────────────────────────────────
  server.registerTool(
    "build_study_plan",
    {
      title: "Build a sequenced study plan",
      description:
        "Week-by-week deliberate-practice plan over the learner's weakest (or chosen) skills, sized to their weekly hours, with real learning resources slotted in where they fit and spaced-review rules.",
      inputSchema: S.buildStudyPlanInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const weeks = args.weeks ?? 4;
      const hoursPerWeek = args.hoursPerWeek ?? 5;

      // Real resource candidates (best-effort) so the plan cites things that exist.
      let resourceCandidates = "";
      try {
        const { data } = await auth.db
          .from("learning_resources")
          .select("title, resource_type, difficulty, provider, duration_minutes")
          .eq("is_active", true)
          .order("times_recommended", { ascending: false })
          .limit(12);
        resourceCandidates = (data ?? [])
          .map(
            (r: any) =>
              `- ${r.title} [${r.resource_type}${r.difficulty ? "/" + r.difficulty : ""}${
                r.provider ? ", " + r.provider : ""
              }${r.duration_minutes ? `, ${r.duration_minutes}min` : ""}]`,
          )
          .join("\n");
      } catch {
        /* best-effort */
      }

      const field = ctx.goal?.targetField ?? ctx.targetField ?? args.goal ?? "their field";
      const research = await researchSafely(deps.research, {
        field,
        role: ctx.goal?.targetRole,
        intents: ["resource", "experience"],
        max: 4,
      });

      // Cold start: a learner who hasn't finished an interview has no skill
      // matrix, and hard-erroring here is what made the study plan look broken
      // for every new user. Fall back through goal → field → research instead.
      const derived = deriveSkillTargets({ ctx, skills: args.skills, field, research });
      const targetSkills = derived.targets;
      if (targetSkills.length === 0) {
        return err(
          "Nothing to plan around yet: no tracked skills, no career goal and no `skills` passed. Set a career goal (set_career_goal), pass `skills`, or complete a mock interview.",
        );
      }

      const { system, user } = studyPlanPrompt({
        weeks,
        hoursPerWeek,
        skillTargets: targetSkills,
        resourceCandidates,
        goal: args.goal,
        ctx,
        research,
      });
      const res = await horus.infer({
        task: "study.build_plan",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "study_plan",
            title: `Study plan: ${targetSkills.map((t) => t.skill).join(", ")} (${weeks}w)`,
            description: args.goal ?? null,
            ai_reasoning: JSON.stringify(res.data).slice(0, 8000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({
        plan: res.data,
        targets: targetSkills,
        targetSource: derived.source,
        recommendationId,
        _meta: {
          model: res.model,
          research: researchMeta(research),
          degraded: degradation([derived.note, !resourceCandidates && "no rows in learning_resources — plan cites methods, not catalogue items"]),
        },
      });
    },
  );

  // ── next_drill ──────────────────────────────────────────────────────────
  server.registerTool(
    "next_drill",
    {
      title: "Get the next spaced-repetition drill",
      description:
        "Picks the skill most due for review (proficiency, time since last touch, trend — SM-2 style) and generates one focused, self-checkable exercise at the right difficulty. Pass `skill` to override the scheduler.",
      inputSchema: S.nextDrillInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });

      let pick = null;
      let coldStartNote: string | undefined;
      if (args.skill) {
        const known = ctx.skills.find((s) => s.name.toLowerCase() === args.skill!.toLowerCase());
        const skill = known ?? { name: args.skill, proficiency: 30, trend: "stable" as const };
        pick = { skill, urgency: 0, whyNow: known ? "requested by the learner" : "requested by the learner (untracked skill — starting easy)" };
      } else {
        pick = pickDrillSkill(ctx.skills);
      }
      if (!pick) {
        // Nothing tracked yet — drill the field's fundamentals rather than
        // refusing. The result writes back, so the matrix exists after this.
        const derived = deriveSkillTargets({ ctx, field: args.field });
        const first = derived.targets[0];
        if (!first) {
          return err(
            "No skills tracked yet and no field to infer from — pass `skill` or `field`, set a career goal, or run a mock interview first.",
          );
        }
        coldStartNote = derived.note;
        pick = {
          skill: { name: first.skill, proficiency: first.from, trend: "stable" as const },
          urgency: 0,
          whyNow: "nothing tested yet — starting with a core skill for your field",
        };
      }

      const difficulty = drillDifficulty(pick.skill.proficiency);
      const { system, user } = drillPrompt({ skill: pick.skill.name, difficulty, field: args.field, ctx });
      const res = await horus.infer({
        task: "study.next_drill",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
      });

      return ok({
        ...(res.data as object),
        scheduling: {
          skill: pick.skill.name,
          proficiency: pick.skill.proficiency,
          difficulty,
          whyNow: pick.whyNow,
          nextReviewInDays: nextReviewInDays(pick.skill.proficiency),
        },
        _meta: { model: res.model, degraded: degradation([coldStartNote]) },
      });
    },
  );

  // ── record_drill_result ─────────────────────────────────────────────────
  server.registerTool(
    "record_drill_result",
    {
      title: "Record a drill result",
      description:
        "Closes the spaced-repetition loop: scores the drill 0-10, updates the skill's proficiency/trend/last-tested in the matrix, and returns the new level plus when the skill is due again. No LLM call — instant.",
      inputSchema: S.recordDrillResultInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, {});
      const known = ctx.skills.find((s) => s.name.toLowerCase() === args.skill.toLowerCase());
      const previous = known?.proficiency ?? 0;
      const projected = proficiencyNudge(previous, args.score);

      const result = await persistSkillSignal(auth.db, auth.userId, {
        name: known?.name ?? args.skill,
        category: known?.category,
        drillScore: args.score,
      });

      const effective = result.newProficiency ?? projected;
      return ok({
        skill: known?.name ?? args.skill,
        score: args.score,
        previousProficiency: result.previousProficiency ?? previous,
        newProficiency: effective,
        delta: effective - (result.previousProficiency ?? previous),
        nextReviewInDays: nextReviewInDays(effective),
        verdict:
          args.score >= 8
            ? "Strong — interval extended."
            : args.score >= 5
              ? "Holding — keep the cadence."
              : "Shaky — this skill comes back sooner.",
        persisted: result.persisted,
      });
    },
  );

  // ── explain_concept ─────────────────────────────────────────────────────
  server.registerTool(
    "explain_concept",
    {
      title: "Explain a concept in layers",
      description:
        "Feynman-style explanation of any interview-relevant concept: intuition → working knowledge → interview-grade depth, with a worked example, common pitfalls, how interviewers probe it, and self-check questions. Backed by a real source when one exists.",
      inputSchema: S.explainConceptInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const level = args.level ?? "working";
      const { system, user } = explainConceptPrompt({ concept: args.concept, level, field: args.field, ctx });
      const res = await horus.infer({
        task: "study.explain_concept",
        system,
        messages: [{ role: "user", content: user }],
        model: level === "interview" ? "deep" : "fast",
        userRef: auth.userId,
      });

      let proof = null;
      try {
        proof = await grounding.findEvidence({ claim: `${args.concept} explained`, skill: args.concept });
      } catch {
        /* grounding best-effort */
      }

      return ok({ ...(res.data as object), proof, _meta: { model: res.model } });
    },
  );

  // ── track_resource_progress ─────────────────────────────────────────────
  server.registerTool(
    "track_resource_progress",
    {
      title: "Track learning-resource progress",
      description:
        "Updates the learner's status on a learning resource (saved → in progress → completed, with optional rating/notes). Completing a resource credits its linked skills in the matrix — progress feeds personalization.",
      inputSchema: S.trackResourceProgressInput,
    },
    async (args) => {
      const nowIso = new Date().toISOString();
      let persisted = false;
      try {
        const { error } = await auth.db.from("user_resources").upsert(
          {
            user_id: auth.userId,
            resource_id: args.resourceId,
            status: args.status,
            progress_percent:
              args.progressPercent ?? (args.status === "completed" ? 100 : args.status === "in_progress" ? 10 : 0),
            ...(args.rating ? { user_rating: args.rating } : {}),
            ...(args.notes ? { notes: args.notes } : {}),
            ...(args.status === "in_progress" ? { started_at: nowIso } : {}),
            ...(args.status === "completed" ? { completed_at: nowIso } : {}),
          },
          { onConflict: "user_id,resource_id" },
        );
        persisted = !error;
      } catch {
        /* best-effort */
      }

      // Completion is learning evidence — credit the resource's linked skills.
      let skillsCredited: string[] = [];
      if (args.status === "completed") {
        try {
          const { data: resource } = await auth.db
            .from("learning_resources")
            .select("title, skill_tags")
            .eq("id", args.resourceId)
            .maybeSingle();
          const tagIds: string[] = Array.isArray(resource?.skill_tags) ? resource!.skill_tags : [];
          if (tagIds.length > 0) {
            const { data: tags } = await auth.db.from("skill_tags").select("name, category").in("id", tagIds);
            const signals = (tags ?? []).map((t: any) => ({
              name: t.name as string,
              category: t.category as string | undefined,
              drillScore: 6.5, // completing a resource ≈ a decent practice session
            }));
            if (signals.length > 0) {
              await persistSkillSignals(auth.db, auth.userId, signals);
              skillsCredited = signals.map((s) => s.name);
            }
          }
        } catch {
          /* best-effort */
        }
      }

      return ok({ resourceId: args.resourceId, status: args.status, persisted, skillsCredited });
    },
  );
}
