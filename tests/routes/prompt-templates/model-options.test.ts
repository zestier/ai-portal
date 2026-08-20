import { describe, expect, it, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

function event(opts: { url?: string }) {
  return {
    locals: { userId: 0 },
    params: {},
    url: new URL(
      opts.url ?? "http://localhost/api/prompt-templates/model-options",
    ),
    request: new Request(
      opts.url ?? "http://localhost/api/prompt-templates/model-options",
      { method: "GET" },
    ),
  };
}

describe("prompt-templates model-options endpoint", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-model-options-");
  });

  it("returns only enabled models on enabled providers", async () => {
    const providersRepo =
      await import("../../../src/lib/server/db/repos/providers");
    const modelsRepo = await import("../../../src/lib/server/db/repos/models");

    providersRepo.upsert({
      id: "openai",
      name: "OpenAI",
      api: "openai-responses",
      enabled: true,
    });
    providersRepo.upsert({
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      enabled: true,
    });
    providersRepo.upsert({
      id: "disabled-provider",
      name: "Disabled",
      api: "openai-completions",
      enabled: false,
    });

    modelsRepo.upsert("openai", {
      id: "gpt-4o",
      name: "gpt-4o",
      enabled: true,
    });
    modelsRepo.upsert("openai", {
      id: "gpt-4o-mini",
      name: "gpt-4o-mini",
      enabled: false,
    });
    modelsRepo.upsert("anthropic", {
      id: "claude-3-5-sonnet",
      name: "Claude 3.5",
      enabled: true,
    });
    modelsRepo.upsert("disabled-provider", {
      id: "gpt-4",
      name: "gpt-4",
      enabled: true,
    });

    const { GET } =
      await import("../../../src/routes/api/prompt-templates/model-options/+server");
    const res = await GET(event({}) as never);
    const body = await res.json();

    // Only enabled models on enabled providers, sorted.
    expect(body.modelOptions).toEqual([
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4o",
    ]);
  });

  it("returns an empty array when no providers are configured", async () => {
    const { GET } =
      await import("../../../src/routes/api/prompt-templates/model-options/+server");
    const res = await GET(event({}) as never);
    const body = await res.json();
    expect(body.modelOptions).toEqual([]);
  });
});
