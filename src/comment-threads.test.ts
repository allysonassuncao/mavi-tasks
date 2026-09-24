import { describe, it, expect } from "vitest";
import { commentThreads, replyRoot } from "./comment-threads";
import type { Comment } from "./types";

const c = (id: string, minute: number, parent_id?: string): Comment => ({
  id,
  company_id: "c",
  task_id: "t",
  author_id: "u",
  body: id,
  created_at: `2026-09-24T10:${String(minute).padStart(2, "0")}:00Z`,
  parent_id: parent_id ?? null,
});

describe("Respostas de comentários", () => {
  it("agrupa as respostas sob o comentário, do mais antigo ao mais novo", () => {
    // As the database returns them: newest first.
    const threads = commentThreads([
      c("r2", 5, "a"),
      c("b", 4),
      c("r1", 3, "a"),
      c("a", 1),
    ]);
    expect(threads.map((t) => t.comment.id)).toEqual(["a", "b"]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(threads[1].replies).toEqual([]);
  });

  it("resposta a um comentário que não foi carregado aparece sozinha", () => {
    const threads = commentThreads([c("r", 5, "antigo"), c("a", 1)]);
    expect(threads.map((t) => [t.comment.id, t.orphan])).toEqual([
      ["a", false],
      ["r", true],
    ]);
  });

  it("comentários sem parent_id (antes da migração) seguem como antes", () => {
    const old = { ...c("a", 1) } as Partial<Comment>;
    delete old.parent_id;
    expect(commentThreads([old as Comment])[0].comment.id).toBe("a");
  });

  it("responder uma resposta entra na mesma conversa", () => {
    expect(replyRoot(c("r", 2, "a"))).toBe("a");
    expect(replyRoot(c("a", 1))).toBe("a");
  });
});
