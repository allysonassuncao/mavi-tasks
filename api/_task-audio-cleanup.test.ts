import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_BATCH,
  handleTaskAudioCleanup,
  taskAudioCleanupEnv,
} from "./_task-audio-cleanup";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const secret = "s".repeat(40);
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  bucket: "public-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  workerSecret: secret,
  budgetMs: 50_000,
};
const path = (n: number) =>
  `00000000-0000-4000-8000-000000000001/audio/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** O banco responde a cada RPC; o GCS, por caminho. */
function fake(claims: string[][], gcs: (path: string) => number) {
  const calls: { rpc: string; body: any }[] = [];
  const deletes: string[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith("https://db.example.com/rest/v1/rpc/")) {
      const rpc = url.split("/").pop()!;
      const body = JSON.parse(init.body as string);
      calls.push({ rpc, body });
      if (rpc === "task_audio_cleanup_claim")
        return new Response(
          JSON.stringify((claims.shift() ?? []).map((p) => ({ path: p }))),
        );
      return new Response(JSON.stringify(body.p_done.length));
    }
    const p = new URL(url).pathname.replace("/public-bucket/", "");
    deletes.push(p);
    expect(init.method).toBe("DELETE");
    return new Response(null, { status: gcs(p) });
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls, deletes };
}

describe("handleTaskAudioCleanup", () => {
  it("só o agendamento, com o segredo do worker", async () => {
    const f = fake([], () => 204);
    for (const auth of [null, "Bearer errado", `Bearer ${secret}x`])
      expect((await handleTaskAudioCleanup(auth, env, f)).status).toBe(401);
    expect(
      (
        await handleTaskAudioCleanup(
          "Bearer ",
          { ...env, workerSecret: "" },
          f,
        )
      ).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("apaga do bucket público e confirma; 404 conta como feito", async () => {
    const f = fake([[path(1), path(2), path(3)]], (p) =>
      p === path(2) ? 404 : p === path(3) ? 500 : 204,
    );
    const res = await handleTaskAudioCleanup(`Bearer ${secret}`, env, f);
    expect(res).toEqual({ status: 200, body: { deleted: 2, failed: 1 } });
    expect(f.deletes).toEqual([path(1), path(2), path(3)]);
    expect(f.calls[0]).toEqual({
      rpc: "task_audio_cleanup_claim",
      body: { p_secret: secret, p_limit: CLEANUP_BATCH },
    });
    expect(f.calls[1]).toEqual({
      rpc: "task_audio_cleanup_done",
      body: {
        p_secret: secret,
        p_done: [path(1), path(2)],
        p_failed: [path(3)],
        p_error: "O GCS não apagou o arquivo.",
      },
    });
    // Rodada incompleta: não pede mais.
    expect(f.calls).toHaveLength(2);
  });

  it("rodada cheia pede a próxima até esvaziar ou o tempo acabar", async () => {
    const full = Array.from({ length: CLEANUP_BATCH }, (_, i) => path(i + 1));
    const f = fake([full, [path(900)]], () => 204);
    const res = await handleTaskAudioCleanup(`Bearer ${secret}`, env, f);
    expect(res.body).toEqual({ deleted: CLEANUP_BATCH + 1, failed: 0 });
    expect(
      f.calls.filter((c) => c.rpc === "task_audio_cleanup_claim"),
    ).toHaveLength(2);

    let t = 0;
    const late = fake([full, full], () => 204);
    await handleTaskAudioCleanup(`Bearer ${secret}`, env, {
      ...late,
      now: () => (t += 30_000),
    });
    expect(
      late.calls.filter((c) => c.rpc === "task_audio_cleanup_claim"),
    ).toHaveLength(1);
  });

  it("sem credenciais do GCS não pega nada da fila", async () => {
    const f = fake([[path(1)]], () => 204);
    const res = await handleTaskAudioCleanup(
      `Bearer ${secret}`,
      { ...env, credentials: null },
      f,
    );
    expect(res.status).toBe(500);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("o bucket é o público (GCS_BUCKET) e o segredo vem sem espaços", () => {
    const base = { supabaseUrl: "u", supabaseKey: "k", credentials: null };
    expect(
      taskAudioCleanupEnv(base, {
        GCS_BUCKET: "publico",
        GCS_DRIVE_BUCKET: "privado",
        AI_WORKER_SECRET: ` ${secret}\n`,
      }),
    ).toMatchObject({ bucket: "publico", workerSecret: secret });
    expect(taskAudioCleanupEnv(base, {}).bucket).toBe("maso_storage_main");
  });
});
