import { describe, expect, it, vi } from "vitest";
import { handleRadarSuggest } from "./_radar-link";
import type { AiEnv } from "./_ai";

const company = "00000000-0000-4000-8000-000000000001";
const item = "00000000-0000-4000-8000-000000000002";
const task = "00000000-0000-4000-8000-000000000003";
const env = { supabaseUrl: "https://db.example.com", supabaseKey: "k", openaiKey: "ok" } as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function deps(opts: { cached?: boolean; blocked?: boolean; denied?: boolean } = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    if (url.endsWith("/radar_task_suggestions")) {
      if (opts.denied) return json({ message: "Sem permissão" }, 403);
      if (opts.cached || body.p_embedding) return json({ tasks: [{ id: task, similarity: 0.71 }] });
      return json({ embed: true, text: "Telefone da loja\nA MAVI não sabe o telefone." });
    }
    if (url.endsWith("/ai_check_limits")) return json({ blocked: !!opts.blocked });
    return json(null);
  });
  const embed = vi.fn(async () => ({ vectors: [[0.1, 0.2]], tokens: 12, model: "text-embedding-3-small" }));
  return { fetch: fetch as unknown as typeof globalThis.fetch, embed, calls };
}

describe("handleRadarSuggest", () => {
  it("com o vetor guardado, responde sem gerar outro", async () => {
    const d = deps({ cached: true });
    const r = await handleRadarSuggest({ company, item }, "Bearer t", env, d);
    expect(r).toEqual({ status: 200, body: { tasks: [{ id: task, similarity: 0.71 }] } });
    expect(d.embed).not.toHaveBeenCalled();
  });

  it("sem vetor: gera do texto do banco, guarda, registra o custo e responde", async () => {
    const d = deps();
    const r = await handleRadarSuggest({ company, item }, "Bearer t", env, d);
    expect(r.body.tasks).toEqual([{ id: task, similarity: 0.71 }]);
    expect(d.embed).toHaveBeenCalledWith(["Telefone da loja\nA MAVI não sabe o telefone."]);
    const second = d.calls.filter((c) => c.url.endsWith("/radar_task_suggestions"))[1];
    expect(second.body.p_embedding).toBe("[0.1,0.2]");
    const usage = d.calls.find((c) => c.url.endsWith("/ai_log_usage"));
    expect(usage?.body).toMatchObject({ p_module: "radar", p_kind: "radar_task_link", p_embedding: 12 });
  });

  it("acima do limite ou sem a chave da OpenAI: só não há sugestões", async () => {
    const d = deps({ blocked: true });
    expect((await handleRadarSuggest({ company, item }, "Bearer t", env, d)).body).toEqual({ tasks: [] });
    expect(d.embed).not.toHaveBeenCalled();
    const e = deps();
    const noKey = { ...env, openaiKey: "" } as AiEnv;
    expect((await handleRadarSuggest({ company, item }, "Bearer t", noKey, e)).body).toEqual({ tasks: [] });
  });

  it("sem login, item inválido ou sem permissão no banco", async () => {
    expect((await handleRadarSuggest({ company, item }, null, env, deps())).status).toBe(401);
    expect((await handleRadarSuggest({ company, item: "x" }, "Bearer t", env, deps())).status).toBe(400);
    expect((await handleRadarSuggest({ company, item }, "Bearer t", env, deps({ denied: true }))).status).toBe(403);
  });
});
