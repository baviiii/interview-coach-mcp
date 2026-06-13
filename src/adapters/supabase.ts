import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { config, requireSupabaseConfig } from "../config.js";

/**
 * RLS-scoped client: every query runs AS the calling user (auth.uid() resolves
 * to them), so Postgres RLS enforces per-user isolation. This mirrors
 * CareerCraft's `_shared/http/auth.ts` pattern — the MCP server never trusts a
 * userId from a tool body; identity comes from the verified JWT.
 */
export function userClientFromJwt(jwt: string): SupabaseClient {
  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
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
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminSingleton;
}
