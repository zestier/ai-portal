import type { WorkspaceTicketPriority } from "$lib/types";

/** Pill tone for each priority, from danger (P0, highest) to neutral (P3, lowest). */
type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";

export const priorityTone: Record<WorkspaceTicketPriority, PillTone> = {
  P0: "danger",
  P1: "warning",
  P2: "accent",
  P3: "neutral",
};

/** Short, human-facing label for each priority. */
export const priorityLabel: Record<WorkspaceTicketPriority, string> = {
  P0: "P0 · Highest",
  P1: "P1 · High",
  P2: "P2 · Normal",
  P3: "P3 · Low",
};
