// Portal-managed pi extension sources: CRUD scoped to a user (mirrors
// prompt-templates.ts). Rows are plaintext operator-authored values; the
// service layer (`src/lib/server/extensions.ts`) validates kinds, materializes
// inline sources, and builds the fingerprint/verify machinery on top.

import { getDb } from "../index";
import { extensionId } from "$lib/ids";
import type {
  PortalExtension,
  PortalExtensionKind,
  PortalExtensionStatus,
} from "$lib/types";

interface ExtensionRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  value: string;
  enabled: number;
  status: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function normalizeKind(raw: string): PortalExtensionKind {
  return raw === "inline" || raw === "package" ? raw : "file";
}

function normalizeStatus(raw: string): PortalExtensionStatus {
  return raw === "archived" ? "archived" : "open";
}

function rowToExtension(r: ExtensionRow): PortalExtension {
  return {
    id: extensionId.encode(r.id),
    userId: r.user_id,
    name: r.name,
    kind: normalizeKind(r.kind),
    value: r.value,
    enabled: r.enabled === 1,
    status: normalizeStatus(r.status),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  };
}

export interface ListOptions {
  status?: PortalExtensionStatus | "all";
}

export function list(
  userId: number,
  opts: ListOptions = {},
): PortalExtension[] {
  const status = opts.status ?? "open";
  const filters = ["user_id = ?"];
  const args: (string | number)[] = [userId];
  if (status !== "all") {
    filters.push("status = ?");
    args.push(status);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM portal_extensions
			 WHERE ${filters.join(" AND ")}
			 ORDER BY status = 'open' DESC, sort_order ASC, id ASC`,
    )
    .all(...args) as ExtensionRow[];
  return rows.map(rowToExtension);
}

function extensionInt(id: string | number): number {
  return typeof id === "number" ? id : extensionId.parse(id);
}

export function get(
  userId: number,
  id: string | number,
): PortalExtension | null {
  const row = getDb()
    .prepare("SELECT * FROM portal_extensions WHERE id = ? AND user_id = ?")
    .get(extensionInt(id), userId) as ExtensionRow | undefined;
  return row ? rowToExtension(row) : null;
}

export interface CreateInput {
  name: string;
  kind: PortalExtensionKind;
  value: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function create(userId: number, input: CreateInput): PortalExtension {
  const now = Date.now();
  const sortOrder = Number.isFinite(input.sortOrder)
    ? Math.trunc(input.sortOrder ?? 0)
    : 0;
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO portal_extensions(
				   user_id, name, kind, value, enabled, status, sort_order, created_at, updated_at, archived_at
				 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`,
      )
      .run(
        userId,
        input.name,
        input.kind,
        input.value,
        input.enabled === false ? 0 : 1,
        sortOrder,
        now,
        now,
      ).lastInsertRowid,
  );
  return {
    id: extensionId.encode(id),
    userId,
    name: input.name,
    kind: input.kind,
    value: input.value,
    enabled: input.enabled !== false,
    status: "open",
    sortOrder,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

export interface UpdateInput {
  name?: string;
  value?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export function update(
  userId: number,
  id: string | number,
  patch: UpdateInput,
): PortalExtension | null {
  const intId = extensionInt(id);
  const current = get(userId, intId);
  if (!current) return null;
  const now = Date.now();
  const sortOrder =
    patch.sortOrder !== undefined && Number.isFinite(patch.sortOrder)
      ? Math.trunc(patch.sortOrder)
      : current.sortOrder;
  getDb()
    .prepare(
      `UPDATE portal_extensions
			 SET name = ?, value = ?, enabled = ?, sort_order = ?, updated_at = ?
			 WHERE id = ? AND user_id = ?`,
    )
    .run(
      patch.name ?? current.name,
      patch.value ?? current.value,
      patch.enabled !== undefined
        ? patch.enabled
          ? 1
          : 0
        : current.enabled
          ? 1
          : 0,
      sortOrder,
      now,
      intId,
      userId,
    );
  return get(userId, intId);
}

export function setEnabled(
  userId: number,
  id: string | number,
  enabled: boolean,
): PortalExtension | null {
  const intId = extensionInt(id);
  const current = get(userId, intId);
  if (!current) return null;
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE portal_extensions SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(enabled ? 1 : 0, now, intId, userId);
  return get(userId, intId);
}

/** Hard delete (the API's `delete` action). */
export function remove(userId: number, id: string | number): boolean {
  const res = getDb()
    .prepare("DELETE FROM portal_extensions WHERE id = ? AND user_id = ?")
    .run(extensionInt(id), userId);
  return res.changes > 0;
}
