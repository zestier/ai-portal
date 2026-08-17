// Pure decision logic for the composer's "arm a follow-up" behaviour.
//
// The composer is a single editable buffer. While a turn is streaming a
// user can press Send/Enter to *arm* the buffer: instead of starting a
// concurrent turn (which the server would reject with a 409) the text is
// held and auto-sent the moment the active turn finishes successfully.
//
// This module captures the "what should a Send/Enter press do right now?"
// decision so it can be unit tested without a DOM. The component wiring in
// `Chat.svelte` translates the result into state changes / network calls.

export type ComposerSendAction =
  | "send" // start a turn immediately with the current buffer
  | "arm" // hold the buffer to auto-send when the active turn finishes
  | "disarm" // cancel a previously armed buffer (text is retained)
  | "noop"; // nothing to do (empty buffer, or empty while streaming)

export function decideComposerAction(input: {
  streaming: boolean;
  armed: boolean;
  hasText: boolean;
}): ComposerSendAction {
  const { streaming, armed, hasText } = input;
  if (!streaming) {
    // No turn in progress: behave exactly as a normal composer — send
    // when there's something to send, otherwise do nothing.
    return hasText ? "send" : "noop";
  }
  // A turn is streaming. Pressing the control toggles the armed flag: an
  // already-armed composer disarms (keeping its text); an unarmed composer
  // with content arms. An empty composer mid-turn does nothing.
  if (armed) return "disarm";
  return hasText ? "arm" : "noop";
}

// Decide what to do with an armed composer when the active turn reaches a
// terminal state. Only a clean success should auto-send; an errored,
// interrupted or stopped turn holds (disarm, keep the text for review).
export function decideArmedFlush(input: {
  armed: boolean;
  failed: boolean;
  hasText: boolean;
}): "flush" | "disarm" | "noop" {
  const { armed, failed, hasText } = input;
  if (!armed) return "noop";
  if (failed || !hasText) return "disarm";
  return "flush";
}
