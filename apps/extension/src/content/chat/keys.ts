/** First 16 hex characters of the SHA-256 of a block's path and content. */
export async function contentHash(path: string, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${path}\u0000${content}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Identifies one `@@FILE` block across re-renders and reloads:
 * `conversationId:messageId:blockIndex:contentHash`. A regenerated or edited reply gets a
 * new message id or new content, so it never inherits an old block's Applied state.
 */
export function blockKey(
  conversationId: string,
  messageId: string,
  blockIndex: number,
  hash: string
): string {
  return `${conversationId}:${messageId}:${blockIndex}:${hash}`;
}
