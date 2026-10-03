import type {
  GraphQueryRequest,
  GraphResult,
  HorusPort,
  InferRequest,
  InferResult,
  RagSearchRequest,
  RagSearchResult,
} from "./port.js";

/**
 * Deterministic, offline Horus. Returns plausible task-shaped JSON so the whole
 * MCP server runs with zero external services (HORUS_MODE=mock). Swap for
 * HttpHorusClient to hit a real Horus deployment — nothing else changes.
 */
export class MockHorusClient implements HorusPort {
  async infer<T = unknown>(req: InferRequest): Promise<InferResult<T>> {
    const data = mockFor(req.task) as T;
    return {
      data,
      raw: JSON.stringify(data),
      model: req.model === "deep" ? "mock-deep" : "mock-fast",
      cached: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async ragSearch(req: RagSearchRequest): Promise<RagSearchResult> {
    return {
      answer: `(mock) Grounded summary for "${req.query}".`,
      passages: [
        {
          text: "Mock passage: focus on trade-offs and concrete examples.",
          title: "Mock Interview Guide",
          source: "mock://interview-guides/1",
          score: 0.82,
        },
      ],
    };
  }

  async graphQuery(_req: GraphQueryRequest): Promise<GraphResult> {
    return { nodes: [], edges: [], raw: { mock: true } };
  }
}

function mockFor(task: string): unknown {
  switch (task) {
    case "interview.build_plan":
      return {
        targetRole: "Software Engineer",
        company: "(from JD)",
        rounds: [
          {
            name: "Technical",
            minutes: 25,
            weight: 0.6,
            focusAreas: ["Data Structures", "System Design"],
            whyWeighted:
              "(mock) Weighted to your weakest tested skills intersected with the role.",
          },
          {
            name: "Behavioral",
            minutes: 20,
            weight: 0.4,
            focusAreas: ["STAR Method", "Communication"],
            whyWeighted: "(mock) Standard behavioral coverage for the seniority.",
          },
        ],
        prepChecklist: [
          "Review your two weakest skills",
          "Prepare 3 STAR stories with quantified results",
          "Re-read the job description and map each requirement to an example",
        ],
        predictedHardestRound: "Technical",
      };

    // Shaped like real blueprint output (warmup → domain → behavioral ×2 →
    // situational → closing) so offline mode exercises the same contract the UI
    // renders — including the behavioural coverage a full loop guarantees.
    case "interview.generate_questions":
      return {
        analysis: {
          roleUnderstanding: "(mock) Role rewards depth over breadth, and evidence over assertion.",
          keyCompetencies: ["Problem Solving", "Judgment under constraint", "Communication"],
        },
        questions: [
          {
            id: 1,
            question: "(mock) Your background points at one project you clearly owned end to end — take me into the messiest week of it.",
            stage: "warmup",
            type: "behavioral",
            difficulty: "easy",
            category: "Background",
            skillsTested: ["Communication"],
            expectedTopics: ["ownership", "context", "constraints"],
            timeAllocationMinutes: 5,
            whyThisQuestion: "(mock) Opens on your own history rather than a template question.",
            followUps: ["(mock) What did you personally decide?", "(mock) What would you do differently now?"],
            signalsSought: ["Concrete ownership", "Clear framing under pressure"],
          },
          {
            id: 2,
            question: "(mock) Walk me through how you'd diagnose the failure mode you hit most often in this work — start from the first signal you'd look at.",
            stage: "domain",
            type: "technical",
            difficulty: "medium",
            category: "Craft",
            skillsTested: ["Problem Solving"],
            expectedTopics: ["diagnosis", "trade-offs", "verification"],
            timeAllocationMinutes: 8,
            whyThisQuestion: "(mock) Probes the weakest skill in your tested matrix.",
            followUps: ["(mock) What would falsify your first hypothesis?", "(mock) What does this cost at 10x volume?"],
            signalsSought: ["Mechanism, not vocabulary"],
          },
          {
            id: 3,
            question: "(mock) Tell me about a time your judgment call turned out to be wrong and someone else absorbed the cost.",
            stage: "behavioral",
            type: "behavioral",
            difficulty: "medium",
            category: "Accountability",
            skillsTested: ["Communication", "Adaptability"],
            expectedTopics: ["situation", "own actions", "measurable result"],
            timeAllocationMinutes: 6,
            whyThisQuestion: "(mock) Behavioural questions are your weakest recorded type.",
            followUps: ["(mock) What did you tell them at the time?", "(mock) What changed in how you work?"],
            signalsSought: ["Ownership without deflection", "A real, quantified consequence"],
          },
          {
            id: 4,
            question: "(mock) Describe a time you pushed back on someone more senior with better information than they had.",
            stage: "behavioral",
            type: "behavioral",
            difficulty: "medium",
            category: "Influence",
            skillsTested: ["Leadership", "Communication"],
            expectedTopics: ["stakes", "how they persuaded", "outcome"],
            timeAllocationMinutes: 6,
            whyThisQuestion: "(mock) Your target seniority is judged on influence, not just output.",
            followUps: ["(mock) What did you concede?", "(mock) How did the relationship hold up after?"],
            signalsSought: ["Evidence-led disagreement", "Result"],
          },
          {
            id: 5,
            question: "(mock) You're a week from a committed deadline and discover the approach won't hold. What do you do first, and who hears about it?",
            stage: "situational",
            type: "situational",
            difficulty: "hard",
            category: "Judgment",
            skillsTested: ["Problem Solving", "Communication"],
            expectedTopics: ["triage", "escalation", "trade-offs"],
            timeAllocationMinutes: 7,
            whyThisQuestion: "(mock) Tests the judgment the role is actually hired for.",
            followUps: ["(mock) What do you cut?", "(mock) What if leadership says ship anyway?"],
            signalsSought: ["Commits to a decision", "Surfaces second-order effects"],
          },
          {
            id: 6,
            question: "(mock) What would you need to see in your first 90 days to know this was the right move?",
            stage: "closing",
            type: "behavioral",
            difficulty: "easy",
            category: "Role fit",
            skillsTested: ["Communication"],
            expectedTopics: ["motivation", "ramp plan", "self-direction"],
            timeAllocationMinutes: 4,
            whyThisQuestion: "(mock) Closes on fit against your stated goal.",
            followUps: ["(mock) What would worry you?", "(mock) What do you want to own by month six?"],
            signalsSought: ["Specific, informed expectations"],
          },
        ],
      };

    case "interview.evaluate_answer":
      return {
        score: 7.2,
        scoreBreakdown: {
          content: { score: 7 },
          communication: { score: 8 },
          behavioral: { score: 7 },
          strategic: { score: 6 },
        },
        skillsAssessed: [
          {
            skill: "System Design",
            proficiencyDemonstrated: 62,
            evidence: "(mock) Mentioned caching but not partitioning.",
          },
        ],
        validation: {
          strengths: ["Clear structure", "Good use of an example"],
          missing: ["Did not quantify the result", "No discussion of trade-offs"],
          redFlags: [],
        },
        improvedAnswer: {
          rewritten: "(mock) A tighter version that leads with impact…",
          keyChanges: ["Added a quantified result", "Surfaced the key trade-off"],
        },
        coachingTips: [
          { priority: "high", tip: "Always close with a measurable result." },
        ],
        rubricApplied: "(mock) Technical weighting: correctness 45%, communication 20%, composure 10%, trade-offs 25%.",
        followUpQuestion: "(mock) You said it scaled — what was the first thing that fell over when it didn't?",
        suggestedFollowup: "How would your design change at 10x write volume?",
      };

    case "interview.next_question":
      return {
        id: 99,
        question: "(mock) You said the fix held — what was the first thing that told you it had, and how long did you wait before believing it?",
        stage: "domain",
        type: "technical",
        difficulty: "hard",
        category: "Verification",
        skillsTested: ["Problem Solving"],
        expectedTopics: ["verification", "false positives", "monitoring"],
        whyThisQuestion: "(mock) Follows directly from what you left unproven in the last answer.",
        followUps: ["(mock) What would have told you it hadn't?", "(mock) Who else needed to know?"],
      };

    case "interview.final_evaluation":
      return {
        overallScore: 74,
        grade: "B",
        readiness: "Almost Ready",
        recommendation: "Lean Hire",
        executiveSummary:
          "(mock) Solid fundamentals; tighten quantification and system-design depth.",
        stageBreakdown: [
          { stage: "behavioral", score: 78, verdict: "(mock) Stories land, results stay vague." },
          { stage: "domain", score: 62, verdict: "(mock) Reasoning is sound until the trade-off question." },
          { stage: "situational", score: 70, verdict: "(mock) Commits to a decision, thin on second-order effects." },
        ],
        strengths: { top: ["Communication"], notable: ["Ownership"] },
        developmentAreas: { critical: ["System Design depth"], important: ["Quantifying impact"] },
        competencyMatrix: [
          { competency: "System Design", score: 62, level: "Developing", developmentNeeded: true },
        ],
        improvementPlan: {
          immediate: [
            {
              area: "System Design",
              action: "Do 3 design drills focusing on data partitioning",
              timeline: "1 week",
            },
          ],
        },
        nextSessionFocus: {
          skills: ["System Design", "Quantifying impact"],
          questionTypes: ["system_design", "behavioral"],
          why: "(mock) Both stages lost points for the same reason: claims without numbers behind them.",
        },
      };

    case "study.suggest_resources":
      // The "nothing in the catalogue, nothing researched" path — moves, not links.
      return {
        resources: [
          {
            title: "(mock) Timed retrieval practice on your weakest skill, 20 minutes daily",
            type: "practice",
            whyRecommended: "(mock) Retrieval beats re-reading, and it generates the signal your matrix is missing.",
            priority: 1,
            howToFind: "(mock) Use next_drill — it schedules the skill that's due.",
          },
          {
            title: "(mock) The standard reference practitioners in this field cite",
            type: "reading",
            whyRecommended: "(mock) Shared vocabulary is what interviewers listen for.",
            priority: 2,
            howToFind: "(mock) Ask two people doing the job what they'd hand a new starter.",
          },
        ],
      };

    case "study.rank_resources":
      // Empty ranking → the tool falls back to a heuristic ordering. In http
      // mode Horus returns a real ranking here.
      return { ranked: [] };

    case "study.explain_concept":
      return {
        concept: "(mock) The requested concept",
        levels: {
          intuition: "(mock) Plain-language mental model.",
          working: "(mock) Practitioner-level mechanics with the moving parts named.",
          interviewGrade: "(mock) The trade-off discussion a strong candidate gives.",
        },
        workedExample: "(mock) One example worked end-to-end.",
        commonPitfalls: ["(mock) Confusing the happy path with the contract."],
        interviewAngles: ["(mock) 'What breaks at 10x scale?'"],
        checkYourself: [{ question: "What changes if the input is sorted?", answerSketch: "(mock) Sketch." }],
        relatedConcepts: ["(mock) Adjacent concept"],
      };

    case "study.build_plan":
      return {
        goal: "(mock) Close the two weakest skills before interviews.",
        weeks: [
          {
            week: 1,
            theme: "System Design foundations",
            targetSkills: ["System Design"],
            sessions: [
              { day: "Mon", minutes: 45, method: "learn", activity: "(mock) Read one primary source on load balancing; write a 5-bullet summary.", skill: "System Design", resourceTitle: null },
              { day: "Wed", minutes: 45, method: "drill", activity: "(mock) Whiteboard a URL shortener; self-grade against the checklist.", skill: "System Design", resourceTitle: null },
              { day: "Sat", minutes: 60, method: "mock", activity: "(mock) One timed design question, recorded.", skill: "System Design", resourceTitle: null },
            ],
            milestone: "(mock) Can sketch a baseline architecture unprompted.",
          },
        ],
        spacedReviewRules: ["(mock) Every Friday, re-drill the weakest skill from two weeks ago."],
        successMetric: "(mock) Design-question average ≥ 7/10 by the final week.",
      };

    case "study.next_drill":
      return {
        drill: {
          skill: "System Design",
          type: "hands_on",
          prompt: "(mock) Design a rate limiter for a public API: state your assumptions, pick an algorithm, and explain where the state lives.",
          difficulty: "medium",
          timeboxMinutes: 15,
          idealAnswerPoints: ["(mock) Names token bucket vs sliding window", "(mock) Places state (Redis) and discusses hot-key risk"],
          selfCheck: ["Did I state assumptions before designing?", "Did I name the failure mode of my choice?"],
        },
      };

    case "career.guidance":
      return {
        headline: "(mock) Strong mid-level base; the gap to the stated goal is proof, not potential.",
        assessment: {
          whereYouAre: "(mock) Mid-level with solid behavioral signal and a real but under-evidenced technical core.",
          momentum: "(mock) Improving — scores trending up over the last four sessions.",
          marketPosition: "(mock) Competitive for mid roles; senior loops will probe system design hard.",
        },
        strengthsToSell: [
          { strength: "Communication", evidence: "(mock) 82/100, improving, strongest question type behavioral", howToPitch: "(mock) Lead stories with the decision you drove, not the task you did." },
        ],
        gapsToClose: [
          { gap: "System Design depth", severity: "critical", fastestFix: "(mock) 3 drills/week + one mock design loop weekly for 6 weeks." },
        ],
        certificationMoves: [
          { action: "renew", certification: "AWS Solutions Architect – Associate", why: "(mock) Expires soon and anchors your cloud story.", timeline: "(mock) Book within 30 days." },
        ],
        trajectoryOptions: [
          { path: "(mock) Senior Backend Engineer", viability: 72, whyItFits: "(mock) Builds on AWS + backend history.", firstMilestone: "(mock) Design-round average ≥ 7/10.", timeToCredible: "(mock) ~3 months" },
          { path: "(mock) Platform Engineer", viability: 64, whyItFits: "(mock) Cert portfolio leans infra.", firstMilestone: "(mock) Ship one IaC artifact.", timeToCredible: "(mock) ~4-5 months" },
        ],
        narrative: {
          elevatorPitch: "(mock) Backend engineer who turns shaky systems into boring ones.",
          linkedinHeadline: "(mock) Backend Engineer · AWS SAA · Distributed systems",
          storyArc: "(mock) Frame the monolith migration as the through-line toward senior scope.",
        },
        nextActions: [
          { action: "(mock) Book the SAA renewal exam", impact: "high", due: "this week" },
          { action: "(mock) Start the 6-week design drill cadence", impact: "high", due: "this week" },
        ],
      };

    case "career.analyze_certifications":
      return {
        portfolioVerdict: "(mock) Two real certs that tell a coherent infra-leaning story; one needs renewal to stay credible.",
        coverage: {
          covered: ["Cloud architecture fundamentals", "Security baseline"],
          missing: ["Container orchestration proof", "System design at senior depth"],
          redundant: [],
        },
        expiryAlerts: [
          { certification: "AWS Solutions Architect – Associate", status: "expiring_soon", action: "(mock) Renew — it anchors the cloud narrative." },
        ],
        marketValue: [
          { certification: "AWS Solutions Architect – Associate", value: "high", why: "(mock) Most-requested cloud cert in postings." },
          { certification: "CompTIA Security+", value: "medium", why: "(mock) Baseline signal; decisive only for gov/defense." },
        ],
        interviewTalkingPoints: [
          { certification: "AWS Solutions Architect – Associate", talkingPoint: "(mock) Pair it with the migration story: cert says theory, the migration says practice." },
        ],
        gapsVsTarget: ["(mock) No orchestration credential (CKA/CKAD) despite platform ambitions."],
      };

    case "career.recommend_certifications":
      return {
        recommendations: [
          {
            certificationId: "ckad",
            name: "Certified Kubernetes Application Developer (CKAD)",
            priority: 1,
            whyThisOne: "(mock) Closes the orchestration gap and is hands-on, matching how you learn.",
            prepPlan: "(mock) 6 weeks: killer.sh sessions weekly, daily 30-min kubectl reps.",
            estimatedWeeks: 8,
            examCostUsd: 445,
            roi: "(mock) Unlocks platform-leaning backend roles.",
          },
        ],
        skipForNow: [{ name: "CISSP", why: "(mock) Experience prerequisite not met; wrong direction for the goal." }],
        sequencingNote: "(mock) Renew SAA first (sunk knowledge), then CKAD.",
      };

    case "career.roadmap":
      return {
        title: "(mock) 12 weeks to Senior Backend Engineer readiness",
        northStar: "(mock) Pass a senior-level loop: design ≥ 7/10, behavioral ≥ 8/10.",
        phases: [
          {
            name: "Foundation",
            weeks: "1-3",
            objective: "(mock) Stabilize the routine and baseline every target skill.",
            skillTargets: [{ skill: "System Design", from: 41, to: 50 }],
            actions: [
              { type: "study", action: "(mock) One design fundamentals chapter/week with written summary", cadence: "weekly", doneWhen: "(mock) 3 summaries exist" },
              { type: "practice", action: "(mock) Spaced drills via next_drill", cadence: "5/week", doneWhen: "(mock) 15 drills logged" },
            ],
            checkpoint: { test: "(mock) One timed design mock", passBar: "(mock) Score ≥ 5.5" },
          },
          {
            name: "Build",
            weeks: "4-7",
            objective: "(mock) Deep work + certification prep; ship one artifact.",
            skillTargets: [{ skill: "System Design", from: 50, to: 65 }],
            actions: [
              { type: "certification", action: "(mock) Renew AWS SAA", cadence: "one-off", doneWhen: "(mock) Exam passed" },
              { type: "project", action: "(mock) Build + write up a rate-limited API gateway demo", cadence: "weekly", doneWhen: "(mock) README published" },
            ],
            checkpoint: { test: "(mock) Mock design loop with a peer", passBar: "(mock) Score ≥ 6.5" },
          },
        ],
        certificationTrack: [{ certification: "AWS Solutions Architect – Associate (renewal)", targetWeek: 6, why: "(mock) Expiring; anchors the cloud story." }],
        interviewCadence: { mocksPerWeek: 2, focusRotation: ["system design", "behavioral depth"] },
        weeklyRhythm: [
          { day: "Tue", block: "(mock) Drill block", minutes: 45 },
          { day: "Sat", block: "(mock) Mock + review", minutes: 90 },
        ],
        riskFactors: [{ risk: "(mock) Streak collapse under work pressure", mitigation: "(mock) Minimum viable day = one 10-minute drill." }],
      };

    // Deliberately field-neutral: offline mode must not smuggle one occupation's
    // assumptions into every other one.
    case "field.profile":
      return {
        isOccupation: true,
        canonicalTitle: "(mock) Field Specialist",
        levels: { entry: "(mock) Trainee", mid: "(mock) Qualified", senior: "(mock) Senior" },
        keySkills: ["(mock) Core craft knowledge", "(mock) Judgment under pressure", "Communication", "Teamwork"],
        technicalWeight: 0.55,
        domainFormats: ["technical", "practical", "case_study"],
        credentials: [{ name: "(mock) Field licence", required: true, note: "(mock) Issued by the field's regulator." }],
      };

    case "interview.hint":
      return {
        hint: "(mock) Don't design yet — first say out loud what the system must guarantee and for how many users.",
        level: "directional",
        framework: "(mock) Requirements → constraints → sketch → deep-dive",
        followupThought: "(mock) Which single guarantee would change your whole design if it flipped?",
      };

    case "profile.synthesize_persona":
      return {
        persona: {
          headline: "(mock) Mid-level backend engineer compounding toward senior scope",
          careerStage: "(mock) Mid-level, 4 years in",
          trajectory: "(mock) Senior backend / platform-leaning",
          superpowers: ["(mock) Communication under pressure", "(mock) Ownership of messy migrations"],
          growthEdges: ["(mock) System design depth", "(mock) Quantifying impact"],
          learningStyle: "(mock) Streak-driven, responds to short daily reps",
          motivators: ["(mock) Visible progress", "(mock) Senior title"],
          riskFlags: ["(mock) Algorithms skill declining from neglect"],
          coachingTone: "(mock) Direct, numbers-first, celebrate streaks",
          summary: "(mock) Four-year backend engineer with real AWS history, strong communication, and a clear design gap that is closing with practice.",
        },
        confidence: 0.74,
        basedOn: ["skill matrix", "session scores", "certifications", "resume excerpt"],
      };

    case "proof.draft_tips":
      return {
        tips: [
          "State your assumptions and target SLOs before you draw a single box.",
          "Lead with the data model — schemas first forces correctness.",
          "Name the bottleneck explicitly, then defend your fix with a number.",
        ],
      };

    default:
      return { note: `(mock) no canned output for task "${task}"` };
  }
}
