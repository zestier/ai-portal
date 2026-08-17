// Unit tests for the provider catalog fetcher (fetch-catalog.ts) against a
// local HTTP stub — no real provider network access.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setupLocalEnv } from "../../helpers/env";
import { fetchProviderCatalog } from "../../../src/lib/server/models/fetch-catalog";
import * as providersRepo from "../../../src/lib/server/db/repos/providers";
import type { ManagedProvider, ProviderApi } from "../../../src/lib/types";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function startStub(handler: Handler): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      try {
        handler(req, res);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function storedProvider(
  baseUrl: string,
  api: ProviderApi,
  id = "test-provider",
): Promise<ManagedProvider> {
  providersRepo.upsert({
    id,
    name: "Test",
    api,
    baseUrl,
    builtin: false,
    enabled: true,
  });
  providersRepo.setApiKey(id, "sk-test-key");
  return providersRepo.get(id)!;
}

describe("fetchProviderCatalog", () => {
  beforeEach(async () => {
    await setupLocalEnv();
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it("maps the Anthropic /v1/models payload (context window + max output tokens)", async () => {
    const baseUrl = await startStub((req, res) => {
      expect(req.headers["x-api-key"]).toBe("sk-test-key");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      json(res, 200, {
        data: [
          {
            id: "claude-sonnet-4-5",
            display_name: "Claude Sonnet 4.5",
            context_window: 200_000,
            max_output_tokens: 64_000,
          },
          { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
        ],
        has_more: false,
      });
    });
    const provider = await storedProvider(baseUrl, "anthropic-messages");
    const result = await fetchProviderCatalog(provider);
    expect(result.models).toEqual([
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ]);
  });

  it("maps OpenRouter pricing (per token -> per million) and context length", async () => {
    const baseUrl = await startStub((req, res) => {
      expect(req.headers.authorization).toBe("Bearer sk-test-key");
      json(res, 200, {
        data: [
          {
            id: "anthropic/claude-sonnet-4.5",
            name: "Claude Sonnet 4.5",
            context_length: 200_000,
            pricing: { prompt: "0.000003", completion: "0.000015" },
          },
        ],
      });
    });
    const provider = await storedProvider(
      baseUrl,
      "openai-completions",
      "openrouter",
    );
    const result = await fetchProviderCatalog(provider);
    expect(result.models).toEqual([
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        cost: { input: 3, output: 15 },
      },
    ]);
  });

  it("maps a bare OpenAI-compatible /models list (ids only)", async () => {
    const baseUrl = await startStub((_req, res) => {
      json(res, 200, {
        data: [{ id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }],
      });
    });
    const provider = await storedProvider(baseUrl, "openai-completions");
    const result = await fetchProviderCatalog(provider);
    expect(result.models.map((m) => m.id)).toEqual([
      "llama3.1:8b",
      "qwen2.5-coder:7b",
    ]);
    expect(result.models[0]).toEqual({ id: "llama3.1:8b" });
  });

  it("maps Google models (name -> id, displayName)", async () => {
    const baseUrl = await startStub((req, res) => {
      expect(new URL(req.url ?? "/", baseUrl).searchParams.get("key")).toBe(
        "sk-test-key",
      );
      json(res, 200, {
        models: [
          { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash" },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        ],
      });
    });
    const provider = await storedProvider(baseUrl, "google-generative-ai");
    const result = await fetchProviderCatalog(provider);
    expect(result.models).toEqual([
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ]);
  });

  it("throws a clear error when no key is stored", async () => {
    const baseUrl = await startStub((_req, res) =>
      json(res, 200, { data: [] }),
    );
    providersRepo.upsert({
      id: "nokey",
      name: "No Key",
      api: "openai-completions",
      baseUrl,
      builtin: false,
      enabled: true,
    });
    const provider = providersRepo.get("nokey")!;
    await expect(fetchProviderCatalog(provider)).rejects.toThrow(
      /No API key stored/,
    );
  });

  it("surfaces HTTP errors with a status and body snippet", async () => {
    const baseUrl = await startStub((_req, res) => {
      res.statusCode = 401;
      res.end("unauthorized");
    });
    const provider = await storedProvider(baseUrl, "openai-completions");
    await expect(fetchProviderCatalog(provider)).rejects.toThrow(
      /401.*unauthorized/s,
    );
  });

  it("throws when no key and no base URL exist", async () => {
    const p: ManagedProvider = {
      id: "nokey",
      name: "No Key",
      api: "openai-completions",
      baseUrl: null,
      hasKey: false,
      headers: {},
      authHeader: false,
      builtin: false,
      enabled: true,
      compat: null,
      createdAt: 0,
      updatedAt: 0,
    };
    await expect(fetchProviderCatalog(p)).rejects.toThrow(/No API key stored/);
  });
});
