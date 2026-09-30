import { config } from "../../config.js";
import { GatewayModelProvider } from "./gateway-client.js";
import { HttpHorusClient } from "./http-client.js";
import { MockHorusClient } from "./mock-client.js";
import type { InferRequest, ModelProvider } from "./port.js";

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
  singleton = withMarket(singleton, config.market);
  return singleton;
}

/**
 * Scopes every model call to the learner's job market. Applied here, once,
 * rather than in each prompt, so no prompt — present or future — can forget it
 * and quietly fall back to the model's default country.
 */
export function withMarket(provider: ModelProvider, market: string): ModelProvider {
  const note = `\n\nMARKET: ${market}. The learner is working or job-hunting in ${market}. Use ${market}'s credentials, regulators and licensing bodies, qualification framework, employers, terminology, spelling and hiring norms — never another country's by default. Where a requirement differs between states, territories or regions within ${market}, say so instead of picking one. Quote costs in ${market}'s currency when you state them.`;
  return {
    infer: <T>(req: InferRequest) => provider.infer<T>({ ...req, system: `${req.system}${note}` }),
    ragSearch: provider.ragSearch?.bind(provider),
    graphQuery: provider.graphQuery?.bind(provider),
  };
}

/** @deprecated use {@link getModelProvider}. */
export const getHorus = getModelProvider;
