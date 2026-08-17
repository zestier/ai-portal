// Integration test: portal config (DB) -> models.json -> shared pi ModelRuntime.
// Proves the seam the Models settings feature relies on: models written by the
// portal are served by pi, keys stored in the portal DB are picked up as
// provider auth, and refresh() picks up edits live.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setupLocalEnv } from "../../helpers/env";
import {
  modelsJsonPath,
  writeModelsJsonFile,
} from "../../../src/lib/server/models/models-json";
import { PortalCredentialStore } from "../../../src/lib/server/models/credential-store";
import * as providersRepo from "../../../src/lib/server/db/repos/providers";
import * as modelsRepo from "../../../src/lib/server/db/repos/models";

describe("portal catalog -> ModelRuntime", () => {
  beforeEach(async () => {
    await setupLocalEnv();
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("serves portal-defined custom providers/models through the runtime", async () => {
    providersRepo.upsert({
      id: "ollama",
      name: "Ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      builtin: false,
      enabled: true,
    });
    modelsRepo.upsert("ollama", {
      id: "llama3.1:8b",
      name: "Llama 3.1 8B",
      contextWindow: 128_000,
      maxTokens: 32_000,
      reasoning: false,
    });
    writeModelsJsonFile();

    const runtime = await ModelRuntime.create({
      modelsPath: modelsJsonPath(),
      credentials: new PortalCredentialStore(),
      refreshOnCreate: false,
    });
    const model = runtime.getModel("ollama", "llama3.1:8b");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Llama 3.1 8B");
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.maxTokens).toBe(32_000);
    expect(model?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("writes a models.json the portal can audit (no apiKey, no plaintext secrets)", async () => {
    providersRepo.upsert({
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      builtin: true,
      enabled: true,
    });
    providersRepo.setApiKey("anthropic", "sk-ant-secret");
    modelsRepo.upsert("anthropic", {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      contextWindow: 200_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    const path = writeModelsJsonFile();
    const doc = JSON.parse(readFileSync(path, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(doc.providers.anthropic).toBeDefined();
    expect(doc.providers.anthropic.models).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain("sk-ant-secret");
  });

  it("exposes a stored portal key as configured auth after refresh", async () => {
    providersRepo.upsert({
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      builtin: true,
      enabled: true,
    });
    providersRepo.setApiKey("anthropic", "sk-ant-test");

    const runtime = await ModelRuntime.create({
      modelsPath: modelsJsonPath(),
      credentials: new PortalCredentialStore(),
      refreshOnCreate: false,
    });
    // refresh() runs the availability pass, which resolves auth through the store.
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.hasConfiguredAuth("anthropic")).toBe(true);
    const auth = await runtime.getAuth("anthropic");
    expect(auth?.auth.apiKey).toBe("sk-ant-test");
  });

  it("picks up portal edits via refresh() without a restart", async () => {
    providersRepo.upsert({
      id: "my-gateway",
      name: "My Gateway",
      api: "openai-completions",
      baseUrl: "https://gateway.example.com/v1",
      builtin: false,
      enabled: true,
    });
    modelsRepo.upsert("my-gateway", { id: "gpt-4o-mini", name: "GPT-4o mini" });
    writeModelsJsonFile();
    const runtime = await ModelRuntime.create({
      modelsPath: modelsJsonPath(),
      credentials: new PortalCredentialStore(),
      refreshOnCreate: false,
    });
    expect(runtime.getModel("my-gateway", "gpt-4o-mini")).toBeDefined();

    // Edit the catalog and reload the same runtime instance.
    modelsRepo.upsert("my-gateway", { id: "gpt-4o", name: "GPT-4o" });
    writeModelsJsonFile();
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel("my-gateway", "gpt-4o")).toBeDefined();
    // Removed models disappear: drop the provider, rewrite, refresh.
    providersRepo.remove("my-gateway");
    writeModelsJsonFile();
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel("my-gateway", "gpt-4o")).toBeUndefined();
    expect(runtime.getModel("my-gateway", "gpt-4o-mini")).toBeUndefined();
  });
});
