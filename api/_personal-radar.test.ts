import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import {
  handlePersonalRadarWorker,
  parsePersonal,
  personalMessage,
  runPersonalRadar,
  type PersonalMaterial,
} from "./_personal-radar";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const group = "00000000-0000-4000-8000-0000000000a1";
const bruno = "00000000-0000-4000-8000-000000000011";
const duda = "00000000-0000-4000-8000-000000000014";
const item = "00000000-0000-4000-8000-0000000000e1";
const task = "00000000-0000-4000-8000-0000000000d1";
const radar = "00000000-0000-4000-8000-0000000000b1";
const msg = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-sonnet-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
const embed = vi.fn();

function material(): PersonalMaterial {
  return {
    group_id: group,
    company_id: company,
    client_id: client,
    client_name: "4282",
    group: "4282 - Make Ads",
    products: ["Make Ads"],
    people: [
      { id: bruno, name: "Bruno Tráfego", teams: ["Tráfego"], about: "Campanhas e relatórios." },
      { id: duda, name: "Duda Design", teams: ["Tráfego"], about: "Artes.", not_mine: ["Relatório de setembro"] },
    ],
    items: [
      {
        id: item, kind: "complaint", title: "CPL alto", summary: "O CPL subiu.", status: "open", asks: 2,
        last: "01/10 10:00", owners: [bruno],
      },
    ],
    tasks: [{ id: task, title: "Trocar público da campanha", status: "progress", assignee: "Bruno Tráfego", due: "03/10" }],
    radar: [{ id: radar, title: "Leads caíram", topic: "Problemas" }],
    context: [{ role: "client", who: "Carlos", text: "Bom dia", at: "01/10 09:00" }],
    lines: [
      { msg: msg(1), role: "client", who: "Carlos", text: "E o CPL, pessoal?", at: "02/10 09:00", item },
      { msg: msg(2), role: "client", who: "Carlos", text: "@184 a arte nova sai quando?", at: "02/10 09:01", to: [duda] },
      { msg: msg(3), role: "team", who: "Bruno Tráfego", text: "Carlos, o CPL já voltou ao normal.", at: "02/10 09:10", reply_text: "E o CPL, pessoal?" },
      { msg: msg(4), role: "client", who: "Carlos", text: "Mandei o logo novo aqui", at: "02/10 09:12", reply_to: bruno, reply_text: "Me manda o logo" },
    ],
    until_at: "2026-10-02T12:12:00Z",
    until_id: msg(4),
    more: false,
  };
}

describe("material do Radar pessoal", () => {
  it("numera pessoas, itens, tarefas, Radar e mensagens, com menções e respostas", () => {
    const { text, refs } = personalMessage(material());
    expect(text).toMatch(/P1 Bruno Tráfego · equipes: Tráfego · o que é com ela: Campanhas e relatórios\./);
    expect(text).toMatch(/P2 Duda Design .* já disse que não era com ela: "Relatório de setembro"/);
    expect(text).toMatch(/I1 \[aberto\] reclamação: CPL alto — O CPL subiu\. \(cobrou 2x; última 01\/10 10:00; donos: P1\)/);
    expect(text).toMatch(/T1 Trocar público da campanha \(com Bruno Tráfego, prazo 03\/10\)/);
    expect(text).toMatch(/R1 Problemas: Leads caíram/);
    expect(text).toMatch(/L1 · 02\/10 09:00 \[cliente\] Carlos: E o CPL, pessoal\? \(já em I1\)/);
    expect(text).toMatch(/L2 · .* → cita P2/);
    expect(text).toMatch(/L4 · .*\(responde a P1: "Me manda o logo"\)/);
    expect(text).toMatch(/L3 · .*\[time\] Bruno Tráfego: .*\(respondendo a "E o CPL, pessoal\?"\)/);
    expect(refs.people.get("P2")?.id).toBe(duda);
    expect(refs.lines.get("L3")?.msg).toBe(msg(3));
  });
});

describe("leitura do modelo", () => {
  const { refs } = personalMessage(material());

  it("troca as referências, garante o dono de quem foi citado e junta o mesmo item", () => {
    const out = parsePersonal(
      JSON.stringify({
        items: [
          { item: "I1", kind: "complaint", summary: "Cobrou de novo.", urgency: 3, lines: [{ ref: "L1", quote: "E o CPL" }], owners: [{ person: "P1", reason: "role", why: "Campanhas" }], task: "T1", radar: "R1" },
          // A menção vence o que o modelo disse; o trecho que não está na fala some.
          { item: null, kind: "question", title: "Quando sai a arte nova", lines: [{ ref: "L2", quote: "não existe" }], owners: [{ person: "P1", reason: "role" }] },
          // Resposta a alguém do time: dono por resposta.
          { kind: "material", title: "Logo novo enviado", lines: ["L4"], owners: [] },
          // Só fala do time não vira item; tipo inválido também não.
          { kind: "request", title: "Só o time", lines: ["L3"] },
          { kind: "outro", title: "Tipo inválido", lines: ["L2"] },
          // O mesmo item duas vezes vira um.
          { item: "I1", kind: "complaint", urgency: 1, lines: ["L2"], owners: [{ person: "P2", reason: "role" }] },
        ],
        resolved: [{ item: "I1", by: "L3" }, { item: "I1", by: "L1" }, { item: "I9", by: "L3" }],
      }),
      refs,
    );
    expect(out.items).toHaveLength(3);
    const [cpl, art, logo] = out.items;
    expect(cpl).toMatchObject({ item_id: item, title: "", urgency: 3, task_id: task, radar_item_id: radar });
    expect(cpl.mentions.map((m) => m.message_id)).toEqual([msg(1), msg(2)]);
    expect(cpl.owners.map((o) => [o.user_id, o.reason])).toEqual([
      [bruno, "role"],
      [duda, "mention"],
    ]);
    expect(art).toMatchObject({ item_id: null, kind: "question", title: "Quando sai a arte nova" });
    expect(art.mentions).toEqual([{ message_id: msg(2), quote: "" }]);
    expect(art.owners.map((o) => [o.user_id, o.reason, o.why])).toEqual([
      [duda, "mention", "Te marcaram"],
      [bruno, "role", ""],
    ]);
    expect(logo.owners.map((o) => [o.user_id, o.reason])).toEqual([[bruno, "reply"]]);
    // Só a fala do time resolve, e só item aberto da lista.
    expect(out.resolved).toEqual([{ item_id: item, message_id: msg(3) }]);
  });

  it("sem JSON, a leitura falha (e o grupo volta para a fila)", () => {
    expect(() => parsePersonal("nada por aqui", refs)).toThrow(/não devolveu JSON/);
  });
});

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
    if (data instanceof Response) return data;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("worker do Radar pessoal", () => {
  it("recusa sem o segredo", async () => {
    const res = await handlePersonalRadarWorker("Bearer errado", env, { fetch: vi.fn() as any, llm: vi.fn(), embed });
    expect(res.status).toBe(401);
  });

  it("lê cada grupo com a MAVI e grava itens, resolução e custo", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": () => (claims++ === 0 ? [{ group_id: group, company_id: company }] : []),
      "rpc/ai_personal_radar_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_personal_radar_store": 1,
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/MAVI Assistente Pessoal/);
      expect(req.instructions).toMatch(/nunca escreve no grupo/);
      expect(req.messages[0].content).toMatch(/Mensagens novas \(L#\):/);
      const meter = newMeter("claude-sonnet-5-5");
      meter.input = 4000;
      meter.output = 250;
      meter.cost = 0.018;
      return {
        text: JSON.stringify({
          items: [{ kind: "question", title: "Quando sai a arte nova", lines: [{ ref: "L2" }], owners: [] }],
          resolved: [{ item: "I1", by: "L3" }],
        }),
        meter,
        rounds: 1,
      };
    });
    let t = 0;
    const stats = await runPersonalRadar(
      { ...env, personalRadarBudgetMs: 400_000 },
      { fetch: fetchImpl, llm, embed, now: () => (t += 60_000) },
    );
    expect(stats).toEqual({ groups: 1, items: 1, skipped: 0, failed: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_personal_radar_store"))!;
    expect(store.body.p_secret).toBe(env.workerSecret);
    expect(store.body.p_group).toBe(group);
    const r = store.body.p_result;
    expect(r).toMatchObject({ until_at: "2026-10-02T12:12:00Z", until_id: msg(4), people: [bruno, duda] });
    expect(r.items[0].owners).toEqual([{ user_id: duda, reason: "mention", why: "Te marcaram" }]);
    expect(r.resolved).toEqual([{ item_id: item, message_id: msg(3) }]);
    expect(r.usage).toMatchObject({ model: "claude-sonnet-5-5", input: 4000, output: 250, cost: 0.018 });
    const route = calls.find((c) => c.url.includes("rpc/ai_worker_route"))!;
    expect(route.body.p_feature).toBe("personal_radar");
  });

  it("nada novo no grupo: não chama a MAVI", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": () => (claims++ === 0 ? [{ group_id: group, company_id: company }] : []),
      "rpc/ai_personal_radar_material": null,
      "rpc/ai_worker_route": null,
    });
    const llm = vi.fn();
    const stats = await runPersonalRadar({ ...env, personalRadarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    expect(stats).toEqual({ groups: 0, items: 0, skipped: 1, failed: 0 });
    expect(llm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes("rpc/ai_personal_radar_store"))).toBe(false);
  });

  it("resposta sem JSON vai para ai_personal_radar_fail", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": () => (claims++ === 0 ? [{ group_id: group, company_id: company }] : []),
      "rpc/ai_personal_radar_material": material(),
      "rpc/ai_worker_route": null,
    });
    const llm: LlmAdapter = vi.fn(async () => ({ text: "sem nada", meter: newMeter("x"), rounds: 1 }));
    const stats = await runPersonalRadar({ ...env, personalRadarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    expect(stats.failed).toBe(1);
    const fail = calls.find((c) => c.url.includes("rpc/ai_personal_radar_fail"));
    expect(fail?.body).toMatchObject({ p_group: group, p_error: "A MAVI não devolveu JSON." });
  });
});
