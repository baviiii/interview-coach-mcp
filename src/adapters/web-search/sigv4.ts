/**
 * AWS Signature Version 4 for one HTTPS request — how the server proves its
 * AWS identity to the AgentCore Gateway (AWS_IAM inbound auth). Small enough
 * to own rather than pull in an SDK; checked against AWS's published test
 * vector in the tests.
 *
 * Credentials come from the environment: on Lambda the execution role's
 * temporary keys are always there (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_SESSION_TOKEN); locally, export them from an SSO profile.
 */

import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function envCredentials(env: NodeJS.ProcessEnv = process.env): AwsCredentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN && { sessionToken: env.AWS_SESSION_TOKEN }) };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding, as SigV4 wants it. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The headers to send: the caller's, plus x-amz-date, the session token when
 * there is one, and Authorization. `host` is signed but not returned — fetch
 * sets it from the URL, to the same value.
 */
export function signRequest(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  now?: Date;
}): Record<string, string> {
  const url = new URL(args.url);
  const amzDate = (args.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers ?? {})) headers[k.toLowerCase()] = v;
  headers["x-amz-date"] = amzDate;
  if (args.credentials.sessionToken) headers["x-amz-security-token"] = args.credentials.sessionToken;
  const signed: Record<string, string> = { ...headers, host: url.host };

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // Not S3, so each path segment is encoded twice; the URL already did it once.
  const canonicalUri = url.pathname.split("/").map(enc).join("/") || "/";

  const canonicalRequest = [
    args.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256(args.body ?? ""),
  ].join("\n");
  const scope = `${day}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${args.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, args.region), args.service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
