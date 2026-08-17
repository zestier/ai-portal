// Portal-backed CredentialStore for the pi ModelRuntime.
//
// pi reads provider credentials through a `CredentialStore` passed to
// ModelRuntime.create({ credentials }). This implementation serves API keys
// from the portal's encrypted `providers.api_key_ct` column, so a provider key
// configured in the portal is available to pi with no environment variables
// and no plaintext key file (the default ~/.pi auth.json is never touched).
//
// The shape mirrors pi-ai's CredentialStore interface; TypeScript checks this
// class structurally at the ModelRuntime.create call site, so any drift from
// the real interface is a compile error there.

import * as providersRepo from "../db/repos/providers";

export interface PortalApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: Record<string, string>;
}

export interface PortalCredentialInfo {
  providerId: string;
  type: "api_key" | "oauth";
}

export interface PortalAuthOperationOptions {
  signal?: AbortSignal;
}

export class PortalCredentialStore {
  async read(
    providerId: string,
    options?: PortalAuthOperationOptions,
  ): Promise<PortalApiKeyCredential | undefined> {
    options?.signal?.throwIfAborted();
    const key = providersRepo.getApiKey(providerId);
    return key ? { type: "api_key", key } : undefined;
  }

  async list(
    options?: PortalAuthOperationOptions,
  ): Promise<readonly PortalCredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return providersRepo
      .listWithKeys()
      .map((p) => ({ providerId: p.id, type: "api_key" as const }));
  }

  async modify(
    providerId: string,
    fn: (
      current: PortalApiKeyCredential | undefined,
    ) => Promise<PortalApiKeyCredential | undefined>,
    options?: PortalAuthOperationOptions,
  ): Promise<PortalApiKeyCredential | undefined> {
    options?.signal?.throwIfAborted();
    const current = await this.read(providerId, options);
    const next = await fn(current);
    // Per the CredentialStore contract, `undefined` means "leave unchanged".
    if (next === undefined) return current;
    if (next.key) providersRepo.setApiKey(providerId, next.key);
    else providersRepo.clearApiKey(providerId);
    return next;
  }

  async delete(
    providerId: string,
    options?: PortalAuthOperationOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    providersRepo.clearApiKey(providerId);
  }
}
