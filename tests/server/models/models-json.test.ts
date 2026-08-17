// Unit tests for the portal -> pi models.json serializer (models-json.ts).

import { describe, expect, it } from "vitest";
import {
  modelToJson,
  serializeCatalog,
} from "../../../src/lib/server/models/models-json";
import type { ManagedModel, ManagedProvider } from "../../../src/lib/types";

function provider(overrides: Partial<ManagedProvider> = {}): ManagedProvider {
  return {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: null,
    hasKey: false,
    headers: {},
    authHeader: false,
    builtin: true,
    enabled: true,
    compat: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function model(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    providerId: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    purpose: null,
    enabled: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: null,
    maxTokens: null,
    reasoning: false,
    input: ["text"],
    thinkingLevelMap: null,
    compat: null,
    samplingParams: null,
    sortOrder: 0,
    ...overrides,
  };
}

describe("serializeCatalog", () => {
  it("omits disabled providers", () => {
    const doc = serializeCatalog([provider({ enabled: false })], [model()]);
    expect(doc.providers).toEqual({});
  });

  it("skips built-in providers that contribute nothing (pi would reject bare entries)", () => {
    const doc = serializeCatalog([provider()], [model({ enabled: false })]);
    expect(doc.providers).toEqual({});
  });

  it("keeps a built-in provider that has enabled models", () => {
    const doc = serializeCatalog(
      [provider()],
      [model({ contextWindow: 200_000, maxTokens: 64_000 })],
    );
    expect(doc.providers.anthropic).toMatchObject({
      name: "Anthropic",
      api: "anthropic-messages",
    });
    expect(doc.providers.anthropic.models).toEqual([
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ]);
  });

  it("keeps a built-in provider with only a baseUrl override", () => {
    const doc = serializeCatalog(
      [provider({ baseUrl: "https://proxy.example.com/v1" })],
      [],
    );
    expect(doc.providers.anthropic).toMatchObject({
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(doc.providers.anthropic.models).toBeUndefined();
  });

  it("serializes custom providers with baseUrl and empty model list", () => {
    const p = provider({
      id: "ollama",
      name: "Ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      builtin: false,
    });
    const doc = serializeCatalog([p], []);
    expect(doc.providers.ollama).toEqual({
      name: "Ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      models: [],
    });
  });

  it("throws for enabled custom providers without a baseUrl", () => {
    const p = provider({
      id: "myserver",
      name: "My Server",
      api: "openai-completions",
      baseUrl: null,
      builtin: false,
    });
    expect(() => serializeCatalog([p], [])).toThrow(/baseUrl is required/);
  });

  it("writes headers and authHeader when set", () => {
    const p = provider({
      baseUrl: "https://proxy.example.com/v1",
      headers: { "x-portkey-api-key": "k" },
      authHeader: true,
    });
    const doc = serializeCatalog([p], []);
    expect(doc.providers.anthropic).toMatchObject({
      headers: { "x-portkey-api-key": "k" },
      authHeader: true,
    });
  });

  it("omits disabled models and only lists enabled ones per provider", () => {
    const p = provider({
      id: "openai",
      name: "OpenAI",
      api: "openai-completions",
      builtin: false,
      baseUrl: "https://api.openai.com/v1",
    });
    const doc = serializeCatalog(
      [p],
      [
        model({
          providerId: "openai",
          id: "gpt-4o",
          name: "GPT-4o",
          enabled: true,
        }),
        model({
          providerId: "openai",
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          enabled: false,
        }),
      ],
    );
    expect(doc.providers.openai.models?.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  it("serializes provider-level compat (OpenRouter routing defaults)", () => {
    const p = provider({
      id: "openrouter",
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      builtin: false,
      compat: {
        openRouterRouting: {
          order: ["anthropic", "friendli"],
          allow_fallbacks: true,
        },
      },
    });
    const doc = serializeCatalog([p], []);
    expect(doc.providers.openrouter).toMatchObject({
      api: "openai-completions",
      compat: {
        openRouterRouting: { order: ["anthropic", "friendli"] },
      },
    });
  });

  it("keeps a built-in provider that contributes only compat (skip guard)", () => {
    const p = provider({
      id: "openrouter",
      name: "OpenRouter",
      api: "openai-completions",
      builtin: true,
      compat: { openRouterRouting: { zdr: true } },
    });
    // baseUrl/headers/models all absent — compat alone must still serialize.
    expect(serializeCatalog([p], []).providers.openrouter).toEqual({
      name: "OpenRouter",
      api: "openai-completions",
      compat: { openRouterRouting: { zdr: true } },
    });
  });

  it("passes provider compat alongside model compat (pi does the merge)", () => {
    const p = provider({
      id: "openrouter",
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      builtin: false,
      compat: { openRouterRouting: { allow_fallbacks: true } },
    });
    const m = model({
      providerId: "openrouter",
      id: "openrouter/anthropic/claude-sonnet-4-5",
      name: "Claude",
      compat: { openRouterRouting: { only: ["anthropic"] } },
    });
    const doc = serializeCatalog([p], [m]);
    expect(doc.providers.openrouter.compat).toMatchObject({
      openRouterRouting: { allow_fallbacks: true },
    });
    expect(doc.providers.openrouter.models?.[0].compat).toEqual({
      openRouterRouting: { only: ["anthropic"] },
    });
  });
});

describe("modelToJson", () => {
  it("emits minimal fields for a plain text model", () => {
    expect(modelToJson(model())).toEqual({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
  });

  it("emits reasoning, image input, window, tokens, thinking map and compat", () => {
    const m = model({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, high: "high", max: "max" },
      compat: { supportsStrictTools: true },
    });
    expect(modelToJson(m)).toEqual({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, high: "high", max: "max" },
      compat: { supportsStrictTools: true },
    });
  });

  it("emits cost only when non-zero, with tiers", () => {
    const m = model({
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        tiers: [
          {
            inputTokensAbove: 200_000,
            input: 6,
            output: 30,
            cacheRead: 0.6,
            cacheWrite: 7.5,
          },
        ],
      },
    });
    expect(modelToJson(m).cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [
        {
          inputTokensAbove: 200_000,
          input: 6,
          output: 30,
          cacheRead: 0.6,
          cacheWrite: 7.5,
        },
      ],
    });
    expect(modelToJson(model()).cost).toBeUndefined();
  });

  it("emits sampling params when present", () => {
    const m = model({ samplingParams: { temperature: 1.0, top_p: 0.95 } });
    expect(modelToJson(m).samplingParams).toEqual({
      temperature: 1.0,
      top_p: 0.95,
    });
  });
});
