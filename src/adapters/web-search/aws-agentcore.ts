/**
 * AWS's own web search: the Web Search Tool connector on an Amazon Bedrock
 * AgentCore Gateway. Amazon runs the index; queries stay inside AWS; it's
 * billed to the AWS account (US$7 per 1,000 searches), so AWS credits pay.
 *
 * The Gateway speaks MCP over HTTPS and authenticates callers with AWS IAM,
 * so each request is SigV4-signed with the Lambda role's own credentials —
 * no key to store. The Gateway prefixes tool names with the target's name,
 * so the WebSearch tool's exact name is looked up once with tools/list.
 * Domain include/exclude filters need connector version 1.2.0 or later.
 */

import { randomUUID } from "node:crypto";

import { cleanResults, siteOf, type WebResult, type WebSearchProvider, type WebSearchRequest } from "./port.js";
import { envCredentials, signRequest, type AwsCredentials } from "./sigv4.js";

const TIMEOUT_MS = 12_000;

interface JsonRpcMessage {
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** A JSON-RPC reply, whether it came back as JSON or as a server-sent event stream. */
export function parseRpcReply(text: string): JsonRpcMessage {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcMessage;
  const data = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
    .pop();
  if (!data) throw new Error("AWS web search sent an empty reply");
  return JSON.parse(data) as JsonRpcMessage;
}

/** The WebSearch tool's results, from structuredContent or the JSON in the text block. */
export function resultsFromToolCall(result: Record<string, unknown>): WebResult[] {
  if (result.isError) {
    const text = (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "unknown error";
    throw new Error(`AWS web search: ${text.slice(0, 200)}`);
  }
  let data = result.structuredContent as { results?: unknown[] } | undefined;
  if (!data) {
    const text = (result.content as Array<{ type?: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text;
    data = text ? (JSON.parse(text) as { results?: unknown[] }) : {};
  }
  return cleanResults(
    (Array.isArray(data.results) ? data.results : []).map((r) => {
      const x = r as { title?: string; url?: string; text?: string; publishedDate?: string };
      return {
        title: x.title ?? "",
        url: x.url ?? "",
        snippet: x.text ?? "",
        ...(x.publishedDate && { publishedDate: x.publishedDate }),
        site: siteOf(x.url ?? ""),
      };
    }),
  );
}

export class AwsWebSearch implements WebSearchProvider {
  readonly name = "aws" as const;
  private toolName: string | null = null;
  private readonly url: string;

  constructor(
    private readonly opts: {
      gatewayUrl: string;
      region: string;
      credentials?: () => AwsCredentials | null;
    },
  ) {
    // The Gateway's MCP endpoint is its URL's /mcp path.
    this.url = /\/mcp\/?$/.test(opts.gatewayUrl) ? opts.gatewayUrl : `${opts.gatewayUrl.replace(/\/$/, "")}/mcp`;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const credentials = (this.opts.credentials ?? envCredentials)();
    if (!credentials) throw new Error("no AWS credentials in the environment");
    const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
    const headers = signRequest({
      method: "POST",
      url: this.url,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
      service: "bedrock-agentcore",
      region: this.opts.region,
      credentials,
    });
    const res = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`AWS web search ${res.status}: ${text.slice(0, 200)}`);
    const reply = parseRpcReply(text);
    if (reply.error) throw new Error(`AWS web search: ${reply.error.message ?? "error"}`);
    return reply.result ?? {};
  }

  private async tool(): Promise<string> {
    if (this.toolName) return this.toolName;
    const listed = await this.rpc("tools/list", {});
    const tools = (listed.tools as Array<{ name?: string }> | undefined) ?? [];
    const name = tools.map((t) => t.name ?? "").find((n) => /(^|___)WebSearch$/.test(n));
    if (!name) throw new Error("the gateway has no WebSearch tool");
    this.toolName = name;
    return name;
  }

  async search(req: WebSearchRequest): Promise<WebResult[]> {
    const domainFilter = {
      ...(req.includeDomains?.length && { include: req.includeDomains.slice(0, 100) }),
      ...(req.excludeDomains?.length && { exclude: req.excludeDomains.slice(0, 100) }),
    };
    const result = await this.rpc("tools/call", {
      name: await this.tool(),
      arguments: {
        query: req.query.slice(0, 200),
        maxResults: Math.min(Math.max(req.max ?? 10, 1), 25),
        ...(Object.keys(domainFilter).length && { filters: { domainFilter } }),
      },
    });
    return resultsFromToolCall(result);
  }
}
