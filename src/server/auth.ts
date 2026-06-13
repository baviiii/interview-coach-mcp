import type { SupabaseClient } from "@supabase/supabase-js";

import { userClientFromJwt } from "../adapters/supabase.js";
import { UnauthorizedError } from "../errors.js";

export interface AuthContext {
  userId: string;
  email: string | null;
  jwt: string;
  /** RLS-scoped Supabase client (runs as this user). */
  db: SupabaseClient;
}

export function extractBearer(header: string | undefined): string {
  if (!header) throw new UnauthorizedError("Missing Authorization header");
  const jwt = header.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) throw new UnauthorizedError("Invalid Authorization header");
  return jwt;
}

/** Verifies the JWT against Supabase and returns an RLS-scoped client. */
export async function authenticate(jwt: string): Promise<AuthContext> {
  const db = userClientFromJwt(jwt);
  const { data, error } = await db.auth.getUser();
  if (error || !data?.user) throw new UnauthorizedError("Invalid session");
  return { userId: data.user.id, email: data.user.email ?? null, jwt, db };
}
