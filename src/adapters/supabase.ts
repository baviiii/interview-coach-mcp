import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { config, requireSupabaseConfig } from "../config.js";

/**
 * Logs every failed database request: the table or function, the status and
 * PostgREST's error code. supabase-js returns errors as values rather than
 * throwing, and most writes here are best-effort and never look at them — so a
 * column dropped by a CareerCraft migration broke skill saving for months with
 * nothing in the logs. Only the path is logged (no query string or body), so
 * no user ids or content reach the logs.
 */
export const loggingFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const target = `${init?.method ?? "GET"} ${url.pathname.replace(/^\/rest\/v1\//, "")}`;
  try {
    const res = await fetch(input, init);
    if (!res.ok) {
      const detail = await res
        .clone()
        .json()
        .then((body: unknown) => {
          const b = (body ?? {}) as { code?: string; message?: string };
          return `${b.code ?? ""} ${b.message ?? ""}`.trim();
        })
        .catch(() => "");
      console.warn(`[db] ${target} → ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }
    return res;
  } catch (e) {
    console.warn(`[db] ${target} → network error: ${(e as Error).message}`);
    throw e;
  }
};

/**
 * RLS-scoped client: every query runs AS the calling user (auth.uid() resolves
 * to them), so Postgres RLS enforces per-user isolation. This mirrors
 * CareerCraft's `_shared/http/auth.ts` pattern — the MCP server never trusts a
 * userId from a tool body; identity comes from the verified JWT.
 */
export function userClientFromJwt(jwt: string): SupabaseClient {
  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: loggingFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let adminSingleton: SupabaseClient | null = null;

/** Service-role client for maintenance tasks only (bypasses RLS). Not hot path. */
export function adminClient(): SupabaseClient {
  if (adminSingleton) return adminSingleton;
  const { url } = requireSupabaseConfig();
  if (!config.supabase.serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  adminSingleton = createClient(url, config.supabase.serviceKey, {
    global: { fetch: loggingFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminSingleton;
}
