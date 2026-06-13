/** Skill taxonomy for interview evaluation. Ported from CareerCraft's
 *  interview-ai edge function so the brain travels with the MCP server. */

export const SKILL_TAXONOMY: Record<string, Record<string, string[]>> = {
  technical: {
    "Data Structures": ["arrays", "trees", "graphs", "hash tables", "heaps"],
    Algorithms: ["sorting", "searching", "dynamic programming", "recursion", "BFS", "DFS"],
    "System Design": ["scalability", "load balancing", "caching", "sharding", "API design"],
    Databases: ["SQL", "NoSQL", "indexing", "transactions", "CAP theorem"],
    "Cloud Services": ["AWS", "Azure", "GCP", "serverless", "containers", "CI/CD"],
    Security: ["authentication", "authorization", "encryption", "OWASP"],
    Networking: ["TCP/IP", "HTTP", "DNS", "load balancers", "CDN"],
  },
  behavioral: {
    Leadership: ["mentoring", "decision making", "conflict resolution", "delegation"],
    Communication: ["clarity", "active listening", "presentation", "stakeholder management"],
    "Problem Solving": ["analytical thinking", "root cause analysis", "prioritization"],
    Teamwork: ["collaboration", "cross-functional work", "feedback"],
    Adaptability: ["change management", "learning agility", "resilience"],
    "STAR Method": ["situation", "task", "action", "result"],
  },
  soft: {
    "Emotional Intelligence": ["self-awareness", "empathy", "self-regulation"],
    "Critical Thinking": ["analysis", "evaluation", "inference"],
    Negotiation: ["persuasion", "compromise", "win-win solutions"],
  },
};

export const QUESTION_TYPES = [
  "technical",
  "behavioral",
  "situational",
  "system_design",
  "coding",
  "case_study",
] as const;

export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
