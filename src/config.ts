import "dotenv/config";

function opt(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * App config. Everything is optional at load time so the server can boot with
 * zero env (HORUS_MODE=mock) for smoke tests. Adapters validate what they need
 * at the point of use — see `requireSupabaseConfig()` / the Horus factory.
 */
export const config = {
  port: Number(opt("PORT", "8787")),
  corsOrigin: opt("CORS_ORIGIN", "*")!,

  supabase: {
    url: opt("SUPABASE_URL"),
    anonKey: opt("SUPABASE_ANON_KEY"),
    serviceKey: opt("SUPABASE_SERVICE_ROLE_KEY"),
  },

  horus: {
    mode: (opt("HORUS_MODE", "mock") as "mock" | "http" | "gateway"),
    tenant: opt("HORUS_TENANT", "careercraft")!,
    baseUrl: opt("HORUS_BASE_URL"),
    apiKey: opt("HORUS_API_KEY"),
    ragUrl: opt("HORUS_RAG_URL"),
    graphUrl: opt("HORUS_GRAPH_URL"),
  },

  // Direct OpenAI-compatible gateway (used when HORUS_MODE=gateway). This is the
  // real, no-mock generation path — same gateway the careercraft edge function uses.
  gateway: {
    url: opt("MODEL_GATEWAY_URL", "https://ai.gateway.lovable.dev/v1/chat/completions")!,
    apiKey: opt("MODEL_GATEWAY_KEY"),
    fast: opt("MODEL_FAST", "google/gemini-2.5-flash")!,
    deep: opt("MODEL_DEEP", "google/gemini-2.5-flash")!,
  },

  grounding: {
    mode: opt("GROUNDING_MODE", "mock") as "mock" | "http" | "reddit" | "hn",
    baseUrl: opt("GROUNDING_BASE_URL"),
    apiKey: opt("GROUNDING_API_KEY"),
  },

  // Live "research BEFORE generate" — pulls real, cited material about ANY field
  // (questions asked, real struggles, required licenses/certs, proven courses)
  // and feeds it to prompts so the coach is career-agnostic, not tech-hardcoded.
  //   auto   → all free, keyless sources (Reddit + Hacker News + Wikipedia + your
  //            own Horus RAG when available). The default.
  //   reddit → Reddit only.
  //   mock   → deterministic offline bundle (dev/smoke).
  //   off    → disabled; every tool degrades to its pre-research behavior.
  research: {
    mode: opt("RESEARCH_MODE", "auto") as "auto" | "reddit" | "mock" | "off",
  },

  // Reddit is the workhorse for "real users who had issues", but its anonymous
  // search.json is increasingly gated (403 from datacenter IPs regardless of
  // User-Agent). Setting FREE Reddit app credentials (https://www.reddit.com/prefs/apps,
  // "script" or "web app") switches to the reliable app-only OAuth endpoint.
  // Still $0 — registration is free. Without creds we fall back to anonymous
  // (works from many residential IPs) and lean on Wikipedia + Hacker News.
  reddit: {
    clientId: opt("REDDIT_CLIENT_ID"),
    clientSecret: opt("REDDIT_CLIENT_SECRET"),
    userAgent: opt("REDDIT_USER_AGENT", "interview-coach-mcp/0.2 (career interview research)")!,
  },
} as const;

export function requireSupabaseConfig(): { url: string; anonKey: string } {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error(
      "Supabase not configured: set SUPABASE_URL and SUPABASE_ANON_KEY",
    );
  }
  return { url: config.supabase.url, anonKey: config.supabase.anonKey };
}
