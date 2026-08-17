// Serialize the portal's provider/model tables into the pi `models.json`
// format consumed by ModelRuntime.create({ modelsPath }) / runtime.refresh().
//
// Rules enforced here mirror pi's provider-composer validation (verified against
// pi-coding-agent 0.84.1):
//  - A provider entry that contributes nothing beyond `name`/`api` is rejected
//    by pi ("must specify baseUrl, headers, compat, modelOverrides, or models").
//    Built-in providers are therefore SKIPPED entirely when they have nothing to
//    add — pi then serves the untouched bundled catalog. Custom providers always
//    carry a baseUrl, so they always serialize.
//  - Custom models require a baseUrl (provider-level for custom providers).
//  - API keys are deliberately NOT written here: keys live encrypted in the
//    portal DB and are served to the runtime through PortalCredentialStore.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../config";
import * as providersRepo from "../db/repos/providers";
import * as modelsRepo from "../db/repos/models";
import type { ManagedModel, ManagedProvider, ModelCost } from "$lib/types";

/** Location of the portal-owned models.json under DATA_DIR. */
export function modelsJsonPath(
  cfg: ReturnType<typeof loadConfig> = loadConfig(),
): string {
  return join(cfg.DATA_DIR, "models.json");
}

export interface PiModelJson {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  samplingParams?: Record<string, unknown>;
}

export interface PiProviderJson {
  name: string;
  api: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: PiModelJson[];
}

export interface PiModelsJson {
  providers: Record<string, PiProviderJson>;
}

function costToJson(cost: ModelCost): Record<string, unknown> | undefined {
  const hasRate =
    cost.input !== 0 ||
    cost.output !== 0 ||
    cost.cacheRead !== 0 ||
    cost.cacheWrite !== 0;
  if (!hasRate && !cost.tiers?.length) return undefined;
  const out: Record<string, unknown> = {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  };
  if (cost.tiers?.length) out.tiers = cost.tiers;
  return out;
}

export function modelToJson(m: ManagedModel): PiModelJson {
  const out: PiModelJson = { id: m.id, name: m.name };
  if (m.reasoning) out.reasoning = true;
  // `input` defaults to ["text"] in pi; omit when that's all there is.
  if (m.input && (m.input.length !== 1 || m.input[0] !== "text"))
    out.input = m.input;
  if (m.contextWindow != null) out.contextWindow = m.contextWindow;
  if (m.maxTokens != null) out.maxTokens = m.maxTokens;
  const cost = costToJson(m.cost);
  if (cost) out.cost = cost;
  if (m.thinkingLevelMap) out.thinkingLevelMap = m.thinkingLevelMap;
  if (m.compat && Object.keys(m.compat).length > 0) out.compat = m.compat;
  if (m.samplingParams && Object.keys(m.samplingParams).length > 0)
    out.samplingParams = m.samplingParams;
  return out;
}

/**
 * Build the models.json document for a set of portal providers/models.
 * Disabled providers/models are omitted; built-in providers with nothing to
 * contribute are omitted so pi keeps its untouched bundled catalog.
 */
export function serializeCatalog(
  providers: readonly ManagedProvider[],
  models: readonly ManagedModel[],
): PiModelsJson {
  const enabledByProvider = new Map<string, ManagedModel[]>();
  for (const m of models) {
    if (!m.enabled) continue;
    const arr = enabledByProvider.get(m.providerId) ?? [];
    arr.push(m);
    enabledByProvider.set(m.providerId, arr);
  }

  const providersOut: Record<string, PiProviderJson> = {};
  for (const p of providers) {
    if (!p.enabled) continue;
    // pi requires a baseUrl for custom providers/models; catch it here with
    // a clear message instead of letting the runtime record a composition error.
    if (!p.builtin && !p.baseUrl) {
      throw new Error(
        `Provider "${p.id}": baseUrl is required for custom providers (set it before enabling).`,
      );
    }
    const pmodels = enabledByProvider.get(p.id) ?? [];
    const hasHeaders = p.headers && Object.keys(p.headers).length > 0;
    const entry: PiProviderJson = { name: p.name, api: p.api };
    if (p.baseUrl) entry.baseUrl = p.baseUrl;
    if (hasHeaders) entry.headers = p.headers;
    if (p.authHeader) entry.authHeader = true;
    if (pmodels.length > 0) {
      entry.models = pmodels.map(modelToJson);
    } else if (!p.builtin) {
      // Custom provider: keep the entry (its baseUrl satisfies pi's
      // validation) with an explicit empty model list.
      entry.models = [];
    }
    // Built-in providers must contribute something beyond name/api, or pi
    // rejects the entry; skipping lets pi serve its bundled catalog.
    if (
      p.builtin &&
      !p.baseUrl &&
      !hasHeaders &&
      !p.authHeader &&
      pmodels.length === 0
    )
      continue;
    providersOut[p.id] = entry;
  }
  return { providers: providersOut };
}

/** Atomically write the current portal catalog to DATA_DIR/models.json. */
export function writeModelsJsonFile(
  cfg: ReturnType<typeof loadConfig> = loadConfig(),
): string {
  const path = modelsJsonPath(cfg);
  const doc = serializeCatalog(providersRepo.list(), modelsRepo.list());
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}
