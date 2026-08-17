// Conversation-scoped store for in-progress code-review feedback.
//
// The file browser (where comments are authored) and the chat composer (where
// the assembled review is sent) live in sibling components that mount/unmount
// as the user switches tabs, so the draft review can't live in component
// state. This module-level Svelte 5 store keeps it alive across tab switches
// and hands the assembled message off to the chat composer.

import {
  formatReviewMessage,
  lineKey,
  type ReviewComment,
  type ReviewLocation,
} from "./review-format";

let nextId = 0;

class ReviewStore {
  /** The conversation the current comments belong to. */
  conversationId = $state<string | null>(null);
  comments = $state<ReviewComment[]>([]);
  /**
   * Text waiting to be appended to the chat composer. The Chat component
   * watches this, consumes it, and resets it to null.
   */
  composerInsert = $state<string | null>(null);

  /** Keys of lines that already have a comment, for UI highlighting. */
  commentedKeys = $derived(new Set(this.comments.map((c) => lineKey(c))));

  /**
   * Point the store at a conversation, discarding comments from a previous
   * one. No-op when already on that conversation so navigations within the
   * same conversation keep the draft review.
   */
  setConversation(id: string) {
    if (this.conversationId === id) return;
    this.conversationId = id;
    this.comments = [];
    this.composerInsert = null;
  }

  add(location: ReviewLocation, body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed) return false;
    this.comments = [
      ...this.comments,
      { ...location, id: `review-${nextId++}`, body: trimmed },
    ];
    return true;
  }

  remove(id: string) {
    this.comments = this.comments.filter((c) => c.id !== id);
  }

  clear() {
    this.comments = [];
  }

  /**
   * Assemble the review into a chat message and queue it for the composer.
   * Returns false when there's nothing to send.
   */
  sendToComposer(): boolean {
    if (this.comments.length === 0) return false;
    this.composerInsert = formatReviewMessage(this.comments);
    this.comments = [];
    return true;
  }

  /** Consume any queued composer text (called by the Chat component). */
  takeComposerInsert(): string | null {
    const text = this.composerInsert;
    this.composerInsert = null;
    return text;
  }
}

export const reviewStore = new ReviewStore();
