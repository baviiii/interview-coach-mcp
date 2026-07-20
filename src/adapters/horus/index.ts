import { config } from "../../config.js";
import { GatewayModelProvider } from "./gateway-client.js";
import { HttpHorusClient } from "./http-client.js";
import { MockHorusClient } from "./mock-client.js";
import type { ModelProvider } from "./port.js";

export * from "./port.js";

let singleton: ModelProvider | null = null;

/**
 * Resolves the ModelProvider from env. **Horus is the default adapter.** To ship
 * turnkey, a buyer implements `ModelProvider` against their own LLM and swaps it
 * here — nothing else in the server changes. mock by default.
 */
export function getModelProvider(): ModelProvider {
  if (singleton) return singleton;

  if (config.horus.mode === "gateway") {
    if (!config.gateway.apiKey) {
      throw new Error("HORUS_MODE=gateway requires MODEL_GATEWAY_KEY");
    }
    singleton = new GatewayModelProvider({
      url: config.gateway.url,
      apiKey: config.gateway.apiKey,
      fast: config.gateway.fast,
      deep: config.gateway.deep,
      timeoutMs: config.limits.llmTimeoutMs,
    });
  } else if (config.horus.mode === "http") {
    if (!config.horus.baseUrl) {
      throw new Error("HORUS_MODE=http requires HORUS_BASE_URL");
    }
    singleton = new HttpHorusClient({
      baseUrl: config.horus.baseUrl,
      apiKey: config.horus.apiKey,
      ragUrl: config.horus.ragUrl,
      graphUrl: config.horus.graphUrl,
      tenant: config.horus.tenant,
      timeoutMs: config.limits.llmTimeoutMs,
    });
  } else {
    singleton = new MockHorusClient();
  }
  return singleton;
}

/** @deprecated use {@link getModelProvider}. */
export const getHorus = getModelProvider;
