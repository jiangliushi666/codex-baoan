import test from "node:test";
import assert from "node:assert/strict";
import { extractCodexProviderFromToml, publicDiscoveryResult, type ProviderDiscoveryResult } from "../integrations/discovery.js";

test("extracts Codex provider details from config toml", () => {
  const parsed = extractCodexProviderFromToml([
    "model_provider = \"custom\"",
    "model = \"gpt-test\"",
    "[model_providers.custom]",
    "name = \"custom\"",
    "base_url = \"https://relay.example/v1\"",
    "wire_api = \"responses\"",
    "experimental_bearer_token = \"sk-secret-value\""
  ].join("\n"));

  assert.equal(parsed.providerName, "custom");
  assert.equal(parsed.baseUrl, "https://relay.example/v1");
  assert.equal(parsed.apiKey, "sk-secret-value");
  assert.equal(parsed.model, "gpt-test");
});

test("public discovery result redacts raw api keys", () => {
  const raw: ProviderDiscoveryResult = {
    generatedAt: "now",
    recommendedProviderId: "p1",
    manualFallback: { enabled: false, reason: "ok" },
    sources: [],
    providers: [{
      id: "p1",
      source: "ccswitch",
      sourceLabel: "ccswitch",
      sourcePath: "db",
      nativeId: "native",
      name: "Provider",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-secret-value",
      maskedApiKey: "sk-...alue",
      hasApiKey: true,
      authState: "present",
      status: "ready",
      statusText: "Ready",
      isCurrent: true,
      isRecommended: true,
      notes: []
    }]
  };

  const json = JSON.stringify(publicDiscoveryResult(raw));
  assert.equal(json.includes("sk-secret-value"), false);
  assert.equal(json.includes("\"apiKey\""), false);
  assert.equal(json.includes("maskedApiKey"), true);
});
