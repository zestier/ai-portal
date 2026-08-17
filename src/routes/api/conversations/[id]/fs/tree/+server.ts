import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  authorizeConversationWorkspace,
  leaseIdFromUrl,
} from "$lib/server/conversation-auth";
import { listDir } from "$lib/server/files";
import {
  status as gitStatus,
  isGitRepo,
  numstat,
  aggregateStatus,
  type NumstatEntry,
} from "$lib/server/git";
import type { ChangeStatus } from "$lib/types";

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const { workdir } = authorizeConversationWorkspace(
    params.id,
    locals.userId,
    leaseIdFromUrl(url),
  );
  const relPath = url.searchParams.get("path") ?? "";
  const includeHidden = url.searchParams.get("hidden") === "1";
  const includeIgnored = url.searchParams.get("ignored") === "1";

  const dir = listDir(workdir, relPath, { includeHidden });
  if (!dir.ok) throw error(dir.status ?? 400, dir.reason);

  let initialized = false;
  const statusByPath = new Map<string, ChangeStatus>();
  const dirAgg = new Map<string, ChangeStatus>();
  const statsByPath = new Map<
    string,
    { added: number | null; removed: number | null }
  >();
  const dirStats = new Map<string, { added: number; removed: number }>();
  if (await isGitRepo(workdir)) {
    initialized = true;
    const entries = await gitStatus(workdir, { includeIgnored });
    for (const e of entries) {
      const agg = aggregateStatus(e, { includeIgnored });
      if (!agg) continue;
      statusByPath.set(e.path, agg);
      const parts = e.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        if (!dirAgg.has(ancestor)) dirAgg.set(ancestor, agg);
      }
    }
    let stats: NumstatEntry[];
    try {
      stats = await numstat(workdir, { kind: "worktree-vs-head" });
    } catch {
      // HEAD may not exist yet (empty repo); skip line stats.
      stats = [];
    }
    for (const s of stats) {
      statsByPath.set(s.path, { added: s.added, removed: s.removed });
      if (s.added == null || s.removed == null) continue;
      const parts = s.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join("/");
        const cur = dirStats.get(ancestor) ?? { added: 0, removed: 0 };
        cur.added += s.added;
        cur.removed += s.removed;
        dirStats.set(ancestor, cur);
      }
    }
  }

  const entries = dir.entries
    .filter((e) => !(relPath === "" && e.name === ".git"))
    .map((e) => {
      const fileStatus = statusByPath.get(e.relPath) ?? null;
      const folderStatus =
        e.type === "directory" ? (dirAgg.get(e.relPath) ?? null) : null;
      const fileStats = statsByPath.get(e.relPath) ?? null;
      const folderStats =
        e.type === "directory" ? (dirStats.get(e.relPath) ?? null) : null;
      return {
        ...e,
        status: fileStatus,
        containsChanges: folderStatus,
        added: fileStats?.added ?? folderStats?.added ?? null,
        removed: fileStats?.removed ?? folderStats?.removed ?? null,
      };
    });

  return json({
    path: relPath.replace(/^\/+/, ""),
    entries,
    git: { initialized },
  });
};
