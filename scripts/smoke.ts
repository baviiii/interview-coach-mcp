/**
 * Smoke test: connects a real MCP client to the running server and lists the
 * tools + resources. Run the server first with AUTH_MODE=dev HORUS_MODE=mock.
 *
 *   npm run start   (in one shell, with AUTH_MODE=dev)
 *   npm run smoke    (in another)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8787/mcp";

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: "Bearer dev" } },
  });
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const resources = await client.listResources();

  console.log("\nTOOLS:");
  for (const t of tools.tools) console.log(`  • ${t.name} — ${t.description ?? ""}`);
  console.log("\nRESOURCES:");
  for (const r of resources.resources) console.log(`  • ${r.name} (${r.uri})`);

  await client.close();
  console.log(`\nOK: ${tools.tools.length} tools, ${resources.resources.length} resources.`);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
