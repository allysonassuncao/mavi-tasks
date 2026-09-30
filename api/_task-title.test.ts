import { describe, expect, it, vi } from "vitest";
import { handleTaskTitle, titleMessage } from "./_task-title";
import type { AiDeps, AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const contract = "00000000-0000-4000-8000-000000000002";
const client = "00000000-0000-4000-8000-000000000003";
const user = "00000000-0000-4000-8000-000000000010";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  model: "claude-haiku-4-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function deps(answer = "Criar 3 artes para a Black Friday", opts: { blocked?: boolean; active?: boolean } = {}) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/memberships")) return json([{ active: opts.active ?? true }]);
    if (url.includes("/contracts")) return json([{ client_id: client, name: "Tráfego pago" }]);
    if (url.includes("/clients")) return json([{ name: "Clínica Sorriso" }]);
    if (url.endsWith("/ai_check_limits"))
      return json({ blocked: !!opts.blocked, message: opts.blocked ? "Limite do mês atingido." : null });
    return json(null);
  });
  const llm = vi.fn(async () => ({
    text: answer,
    rounds: 1,
    meter: { model: "claude-haiku-4-5", input: 200, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.00026 },
  }));
  return { d: { fetch, llm, embed: vi.fn() } as unknown as AiDeps, calls, llm };
}

describe("título das tarefas novas pela MAVI", () => {
  it("escreve o título a partir da descrição e dos áudios e registra o gasto", async () => {
    const { d, calls, llm } = deps('Título: "Criar 3 artes para a Black Friday".');
    const res = await handleTaskTitle(
      { company, contract, description: "Fazer 3 artes da Black Friday", audio: "Áudio 1: para o feed" },
      token,
      env,
      d,
    );
    expect(res).toEqual({ status: 200, body: { title: "Criar 3 artes para a Black Friday" } });
    const prompt = (llm.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0]
      .content;
    expect(prompt).toContain("Cliente: Clínica Sorriso");
    expect(prompt).toContain("Fazer 3 artes da Black Friday");
    expect(prompt).toContain("Áudio 1: para o feed");
    const route = calls.find((c) => c.url.endsWith("/ai_resolve_route"));
    expect(JSON.stringify(route?.body)).toContain("task_title");
    expect(calls.find((c) => c.url.endsWith("/ai_log_usage"))?.body).toMatchObject({
      p_module: "tasks",
      p_kind: "task_title",
      p_client: client,
      p_contract: contract,
    });
  });

  it("sem descrição nem áudio, sem login, sem acesso ou no limite de gasto não chama a MAVI", async () => {
    const empty = deps();
    expect((await handleTaskTitle({ company, contract }, token, env, empty.d)).status).toBe(400);
    expect((await handleTaskTitle({ company, contract, description: "abc" }, null, env, empty.d)).status).toBe(401);
    const off = deps(undefined, { active: false });
    expect((await handleTaskTitle({ company, contract, description: "abcd" }, token, env, off.d)).status).toBe(403);
    const blocked = deps(undefined, { blocked: true });
    const res = await handleTaskTitle({ company, contract, description: "abcd" }, token, env, blocked.d);
    expect(res).toEqual({ status: 429, body: { error: "Limite do mês atingido." } });
    for (const x of [empty, off, blocked]) expect(x.llm).not.toHaveBeenCalled();
  });

  it("resposta vazia vira erro (o formulário salva com o título de reserva)", async () => {
    const { d } = deps("  ");
    expect((await handleTaskTitle({ company, contract, description: "abcd" }, token, env, d)).status).toBe(502);
  });

  it("a mensagem traz só o que existe", () => {
    const m = titleMessage({ client: "", product: "", hint: "", description: "Trocar banner", audio: "" });
    expect(m).not.toContain("Cliente:");
    expect(m).not.toContain("Áudios");
    expect(m).toContain("Trocar banner");
  });
});
