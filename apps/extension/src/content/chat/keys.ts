/** First 16 hex characters of the SHA-256 of a block's path and content. */
export async function contentHash(path: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${path}\u0000${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Identifies one card across re-renders and reloads:
 * `conversationId:messageId:slot:contentHash`, where the slot is a `@@FILE` block's index
 * or `read` for the READ card. A regenerated or edited reply gets a new message id or new
 * content, so it never inherits an old card's state.
 */
export function blockKey(
  conversationId: string,
  messageId: string,
  slot: number | 'read' | `d${number}` | `r${number}`,
  hash: string
): string {
  return `${conversationId}:${messageId}:${slot}:${hash}`;
}
