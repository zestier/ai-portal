// Pure queue helpers for in-flight interactive requests (permission prompts,
// auto-mode-switch confirmations, user_input, elicitation, etc.).
//
// The SDK can fire multiple interactive callbacks concurrently (parallel
// tool calls), so the UI must hold them in a queue rather than a single
// slot — otherwise a later request clobbers the earlier one, hiding the
// prompt while it stays pending on the server and deadlocking that tool
// call.
//
// Resolutions (`interactive.resolved`) drop the matching entry by
// `requestId`. This is also what protects against replayed event logs
// resurrecting prompts the user already answered.

import type { InteractiveRequestView } from "$lib/types";

export function addInteractive(
  queue: InteractiveRequestView[],
  req: InteractiveRequestView,
): InteractiveRequestView[] {
  // Dedupe by requestId so replaying the turn's event log on reconnect
  // doesn't double-insert prompts already in the queue.
  if (queue.some((p) => p.requestId === req.requestId)) return queue;
  return [...queue, req];
}

export function removeInteractive(
  queue: InteractiveRequestView[],
  requestId: string,
): InteractiveRequestView[] {
  return queue.filter((p) => p.requestId !== requestId);
}
