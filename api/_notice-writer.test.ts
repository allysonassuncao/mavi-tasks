import { describe, expect, it, vi } from "vitest";
import {
  handleNoticeWriter,
  parseWriter,
  writerMessage,
} from "./_notice-writer";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000010";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  model: "claude-sonnet-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

function deps(role = "admin", answer = "", hidden: string[] = []) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("/memberships"))
      return json([{ role, name: "Ana", hidden_pages: hidden, active: true }]);
    if (url.includes("/companies"))
      return json([{ name: "Make", timezone: "America/Sao_Paulo" }]);
    if (url.endsWith("/ai_check_limits"))
      return json({ blocked: false, message: null });
    if (url.endsWith("/ai_resolve_route")) return json(null);
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: {
      model: "claude-sonnet-5",
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
    },
  }));
  return { d: { fetch, llm, embed: vi.fn() } as unknown as AiDeps, calls, llm };
}

describe("A MAVI na escrita do aviso", () => {
  it("escreve a partir de uma ideia e devolve as sugestões conferidas", async () => {
    const answer = `Claro! {"title": "Sexta sem expediente", "body": "Na sexta não teremos expediente.\\n\\n- Voltamos na segunda", "level": "important", "formats": {"popup": false, "inbox": true, "push": true, "banner": true}, "require_ack": false, "audience": [{"kind": "everyone"}, {"kind": "client", "name": "Clínica Sorriso", "mode": "x"}, {"kind": "robot", "name": "?"}], "why": "Muda a rotina de todos."}`;
    const { d, calls, llm } = deps("manager", answer);
    const res = await handleNoticeWriter(
      { company, mode: "write", idea: "avisar que sexta não tem expediente" },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Sexta sem expediente");
    expect(res.body.level).toBe("important");
    expect(res.body.audience).toEqual([
      { kind: "everyone", name: "" },
      { kind: "client", name: "Clínica Sorriso", mode: "both" },
    ]);
    const log = calls.find((c) => c.url.endsWith("/ai_log_usage"));
    expect(log?.body).toMatchObject({
      p_module: "notices",
      p_kind: "writer_write",
      p_cost: 0.001,
    });
    const prompt = (
      llm.mock.calls[0] as unknown as [{ messages: { content: string }[] }]
    )[0].messages[0].content;
    expect(prompt).toContain("Quem publica: Ana");
    expect(prompt).toContain("avisar que sexta não tem expediente");
  });

  it("colaborador, MAVI desligada e sem login não passam", async () => {
    expect(
      (
        await handleNoticeWriter(
          { company, mode: "write", idea: "abc" },
          null,
          env,
          deps().d,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleNoticeWriter(
          { company, mode: "write", idea: "abcd" },
          token,
          env,
          deps("member").d,
        )
      ).status,
    ).toBe(403);
    const off = await handleNoticeWriter(
      { company, mode: "write", idea: "abcd" },
      token,
      env,
      deps("admin", "", ["assistant"]).d,
    );
    expect(off.body.error).toMatch(/desligada/);
  });

  it("pedido vazio não chama o modelo", async () => {
    const { d, llm } = deps();
    expect(
      (await handleNoticeWriter({ company, mode: "improve" }, token, env, d))
        .status,
    ).toBe(400);
    expect(
      (
        await handleNoticeWriter(
          { company, mode: "write", idea: "a" },
          token,
          env,
          d,
        )
      ).status,
    ).toBe(400);
    expect(llm).not.toHaveBeenCalled();
  });

  it("resposta sem JSON vira um erro amigável, com o custo registrado", async () => {
    const { d, calls } = deps("admin", "não consigo");
    const res = await handleNoticeWriter(
      { company, mode: "suggest", text: "Aviso" },
      token,
      env,
      d,
    );
    expect(res.status).toBe(502);
    expect(calls.some((c) => c.url.endsWith("/ai_log_usage"))).toBe(true);
  });

  it("cada modo pede só o que usa", () => {
    const ctx = { company: "Make", author: "Ana", today: "hoje" };
    const input = {
      idea: "",
      title: "T",
      text: "Texto",
      style: "short" as const,
    };
    expect(writerMessage("improve", input, ctx)).toMatch(
      /bem mais curto[\s\S]*só title e body/,
    );
    expect(writerMessage("suggest", input, ctx)).toMatch(/só level, formats/);
    expect(
      parseWriter('{"title": "Título", "level": "critical"}', "improve"),
    ).toEqual({ title: "Título" });
    expect(
      parseWriter('{"title": "Título", "level": "critical"}', "suggest"),
    ).toEqual({ level: "critical" });
  });
});
