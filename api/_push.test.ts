import { describe, expect, it, vi } from "vitest";
import { handlePush } from "./_push";

const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  vapidPublicKey: "BPublic",
  vapidPrivateKey: "private",
  vapidSubject: "mailto:x@example.com",
  secret: "s".repeat(40),
};
const auth = `Bearer ${env.secret}`;
const sub = (n: number) => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: "k", auth: "a" },
});
const body = (subs = [sub(1)]) => ({
  subscriptions: subs,
  message: {
    title: "Nova tarefa para você",
    body: "Ana criou: Revisar",
    tag: "n1",
    url: "/tarefas/t1",
  },
});

describe("handlePush", () => {
  it("entrega a chave pública ao navegador", async () => {
    const res = await handlePush("GET", {}, null, env, vi.fn());
    expect(res).toEqual({ status: 200, body: { publicKey: "BPublic" } });
  });
  it("avisa quando o servidor não está configurado", async () => {
    const res = await handlePush(
      "GET",
      {},
      null,
      { ...env, secret: "" },
      vi.fn(),
    );
    expect(res.status).toBe(503);
  });
  it("recusa envios sem o segredo do banco", async () => {
    const send = vi.fn();
    const res = await handlePush("POST", body(), "Bearer errado", env, send);
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it("envia para cada navegador com título, texto e link", async () => {
    const send = vi.fn().mockResolvedValue({});
    const res = await handlePush(
      "POST",
      body([sub(1), sub(2)]),
      auth,
      env,
      send,
    );
    expect(res).toEqual({ status: 200, body: { sent: 2, gone: 0, failed: 0 } });
    expect(JSON.parse(send.mock.calls[0][1])).toEqual({
      title: "Nova tarefa para você",
      body: "Ana criou: Revisar",
      tag: "n1",
      url: "/tarefas/t1",
    });
  });
  it("não abre links para fora do app", async () => {
    const send = vi.fn().mockResolvedValue({});
    const b = body();
    b.message.url = "https://phishing.example";
    await handlePush("POST", b, auth, env, send);
    expect(JSON.parse(send.mock.calls[0][1]).url).toBe("/");
  });
  it("pede ao banco para esquecer navegadores que não existem mais", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce({ statusCode: 500 });
    const fetchMock = vi.fn().mockResolvedValue(new Response("1"));
    const res = await handlePush(
      "POST",
      body([sub(1), sub(2), sub(3)]),
      auth,
      env,
      send,
      fetchMock as unknown as typeof fetch,
    );
    expect(res.body).toEqual({ sent: 1, gone: 1, failed: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://db.example.com/rest/v1/rpc/push_gone");
    expect(JSON.parse(init.body)).toEqual({
      p_secret: env.secret,
      p_endpoints: ["https://push.example/2"],
    });
  });
});
