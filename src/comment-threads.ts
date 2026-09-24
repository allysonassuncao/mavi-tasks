import type { Comment } from "./types";

export interface CommentThread {
  comment: Comment;
  replies: Comment[];
  /** A reply whose first comment is no longer among the loaded ones. */
  orphan: boolean;
}

const byTime = (a: Comment, b: Comment) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * Comments as conversations, oldest first (they read like a chat): each
 * first comment with its replies under it. Only the latest comments are
 * loaded, so a reply to an older one stands on its own, marked `orphan`.
 */
export function commentThreads(comments: Comment[]): CommentThread[] {
  const sorted = [...comments].sort(byTime);
  const threads = new Map<string, CommentThread>();
  for (const c of sorted)
    if (!c.parent_id)
      threads.set(c.id, { comment: c, replies: [], orphan: false });
  const result: CommentThread[] = [];
  for (const c of sorted) {
    const parent = c.parent_id ? threads.get(c.parent_id) : undefined;
    if (parent) parent.replies.push(c);
    else if (c.parent_id)
      result.push({ comment: c, replies: [], orphan: true });
    else result.push(threads.get(c.id)!);
  }
  return result;
}

/** The conversation a reply to `c` joins: its first comment. */
export function replyRoot(c: Comment): string {
  return c.parent_id ?? c.id;
}
