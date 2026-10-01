import { describe, expect, it, vi } from "vitest";
import {
  builderMessages,
  catalogGuide,
  findOptions,
  handleDashboardBuilder,
  parseBuilder,
  previewText,
  type DashState,
} from "./_dashboard-mavi";
import type { AiDeps, AiEnv } from "./_ai";
import type { AgentRequest } from "./_ai-llm";

const company = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000010";
const aurora = "00000000-0000-4000-8000-0000000000a1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const env = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  anthropicKey: "sk",
  model: "claude-opus-5-5",
  providerKey: null,
} as unknown as AiEnv;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const stat = {
  viz: "stat",
  groupBy: "none",
  queries: [{ ref: "A", source: "tasks", metric: "count", dateField: "created_at", filters: [] }],
};
const state: DashState = {
  name: "Operação",
  description: "",
  panels: [{ id: "criadas", title: "Tarefas criadas", x: 0, y: 0, w: 3, h: 3, spec: stat as never }],
  range: { from: "2026-09-01", to: "2026-09-30", preset: "last_month" },
  filters: { clients: [aurora] },
  focus: "criadas",
  isNew: false,
};
const dashboard = { ...state, range: state.range };

function deps(run: (req: AgentRequest) => Promise<string>, member: Record<string, unknown> = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/memberships?select=role"))
      return json([{ role: "admin", hidden_pages: [], active: true, name: "Ana", ...member }]);
    if (url.includes("/companies?")) return json([{ timezone: "America/Sao_Paulo" }]);
    if (url.includes("/clients?"))
      return json([
        { id: aurora, name: "Aurora Studio" },
        { id: "00000000-0000-4000-8000-0000000000a2", name: "Norte Coffee" },
      ]);
    if (url.endsWith("/ai_check_limits")) return json({ blocked: false, message: null });
    if (url.endsWith("/dashboard_preview")) return json({ series: { A: [{ k: "total", v: 12 }] } });
    return json(null);
  });
  const tools: string[] = [];
  const llm = vi.fn(async (req: AgentRequest) => ({
    text: await run({
      ...req,
      execute: async (name, input) => {
        const out = await req.execute(name, input);
        tools.push(`${name}: ${typeof out === "string" ? out : out.text}`);
        return out;
      },
    }),
    rounds: 1,
    meter: { model: "claude-opus-5-5", input: 900, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.03 },
  }));
  return { d: { fetch, llm, embed: vi.fn() } as unknown as AiDeps, calls, llm, tools };
}

describe("MAVI nos Dashboards: o que ela sabe do módulo", () => {
  it("o catálogo vem do mesmo lugar do editor", () => {
    const g = catalogGuide(["tasks", "hours"]);
    expect(g).toContain('source "tasks"');
    expect(g).toContain("late (Tarefas atrasadas");
    expect(g).toContain("executor (Quem executou (todos))");
    expect(g).toContain("HORAS TRABALHADAS");
    expect(g).not.toContain('source "notices"');
  });

  it("o dashboard atual vai na última mensagem, com os nomes dos filtros e o painel de onde abriu", () => {
    const m = builderMessages(
      [{ role: "user", content: "Explica este número" }],
      state,
      new Map([[aurora, "Aurora Studio"]]),
      "quinta-feira, 1 de outubro de 2026",
    );
    expect(m).toHaveLength(1);
    expect(m[0].content).toMatch(/^Explica este número\n\n---\nHoje é quinta-feira/);
    expect(m[0].content).toContain(`Clientes: Aurora Studio (${aurora})`);
    expect(m[0].content).toContain("id criadas (A PESSOA ABRIU A CONVERSA POR ESTE PAINEL)");
    expect(builderMessages([], state, new Map(), "hoje")[0].content).toContain("(A pessoa abriu a conversa.)");
  });

  it("a prévia em poucas linhas: total, tempo e ranking", () => {
    expect(previewText(stat as never, { series: { A: [{ k: "total", v: 12 }] } })).toBe(
      "A (Quantidade de tarefas, número): 12",
    );
    const time = { ...stat, viz: "line", groupBy: "time" };
    expect(previewText(time as never, { series: { A: [{ k: "2026-09-01", v: 0 }, { k: "2026-09-02", v: 0 }] } })).toMatch(
      /vazio/,
    );
    const rank = { ...stat, viz: "hbar", groupBy: "client" };
    expect(
      previewText(rank as never, { series: { A: [{ k: "a", l: "Aurora", v: 5 }, { k: null, v: 2 }] } }),
    ).toContain("Aurora: 5; (sem valor): 2");
  });

  it("acha os nomes sem acento e sem inventar", async () => {
    const rows = vi.fn(async () => [
      { id: "1", name: "Ótica Visão" },
      { id: "2", name: "Aurora" },
    ]);
    const load = { rows, rpc: vi.fn() };
    expect(await findOptions("client", "otica", load)).toBe("Ótica Visão — id 1");
    expect(await findOptions("client", "zeta", load)).toMatch(/^Nada com "zeta"\. Existem: Ótica Visão, Aurora/);
    expect(await findOptions("robot", "", load)).toBe("Tipo inválido.");
  });
});

describe("MAVI nos Dashboards: a proposta", () => {
  it("confere cada painel no catálogo e só altera ou remove o que existe", () => {
    const r = parseBuilder(
      JSON.stringify({
        reply: "Montei.",
        proposal: {
          name: "Atrasos",
          range: "month",
          add: [
            {
              title: "Atrasadas por cliente",
              why: "Quem mais atrasa",
              spec: {
                viz: "hbar",
                groupBy: "client",
                limit: 12,
                queries: [{ source: "tasks", metric: "late", filters: [{ field: "client", values: [aurora] }] }],
              },
            },
            { title: "Inventado", spec: { viz: "stat", queries: [{ source: "tasks", metric: "lucro" }] } },
            { title: "Pessoa errada", spec: { viz: "hbar", groupBy: "validator", queries: [{ source: "tasks", metric: "count" }] } },
          ],
          update: [{ id: "criadas", title: "Tarefas criadas no mês", spec: stat }, { id: "nao-existe", title: "X", spec: stat }],
          remove: ["criadas", "outro"],
        },
      }),
      state,
      ["tasks", "hours"],
    );
    expect(r.proposal?.name).toBe("Atrasos");
    expect(r.proposal?.range).toBe("month");
    expect(r.proposal?.add).toHaveLength(1);
    const added = r.proposal!.add[0];
    // Os campos que faltaram vêm do catálogo; o limite vira o mais próximo da lista.
    expect(added).toMatchObject({ w: 6, h: 6, why: "Quem mais atrasa" });
    expect(added.spec).toMatchObject({ limit: 10, queries: [{ ref: "A", dateField: "created_at" }] });
    expect(r.proposal?.update.map((p) => p.id)).toEqual(["criadas"]);
    expect(r.proposal?.remove).toEqual(["criadas"]);
    expect(r.dropped).toHaveLength(3);
    expect(r.dropped!.join(" ")).toMatch(/lucro/);
    expect(r.dropped!.join(" ")).toMatch(/validator/);
  });

  it("pergunta com opções; pronta não pergunta mais", () => {
    const r = parseBuilder(
      '{"reply":"Legal!","question":{"text":"Qual período?","options":["Este mês","Este mês","Últimos 30 dias"]}}',
      state,
      ["tasks"],
    );
    expect(r.question).toEqual({ text: "Qual período?", options: ["Este mês", "Últimos 30 dias"], multiple: false });
    expect(r.proposal).toBeUndefined();
    expect(parseBuilder('{"reply":"Pronto","question":{"text":"Mais?"},"ready":true}', state, ["tasks"]).question).toBeUndefined();
  });

  it("conversa pelo servidor: confere os nomes, roda a prévia e registra o custo nos Dashboards", async () => {
    const { d, calls, llm, tools } = deps(async (req) => {
      await req.execute("find_options", { kind: "client", search: "aurora" });
      await req.execute("preview_panel", { spec: stat });
      await req.execute("preview_panel", { spec: { viz: "stat", queries: [{ source: "notices", metric: "seen" }] } });
      return JSON.stringify({ reply: "Pronto!", proposal: { add: [{ title: "Criadas", spec: stat }] }, ready: true });
    });
    const res = await handleDashboardBuilder(
      { company, messages: [{ role: "user", content: "Quero ver as tarefas criadas" }], dashboard },
      token,
      env,
      d,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reply: "Pronto!", ready: true, model: "claude-opus-5-5" });
    expect(tools[0]).toContain(`Aurora Studio — id ${aurora}`);
    expect(tools[1]).toContain("Quantidade de tarefas, número): 12");
    // O administrador vê o Mural; a prévia foi com o período e os filtros do dashboard.
    expect(tools[2]).not.toMatch(/inválido/);
    const preview = calls.find((c) => c.url.endsWith("/dashboard_preview"))?.body;
    expect(preview).toMatchObject({ p_from: "2026-09-01", p_to: "2026-09-30", p_vars: { filters: { clients: [aurora] } } });
    const req = (llm.mock.calls[0] as unknown as [AgentRequest])[0];
    expect(req.tools.map((t) => t.name)).toEqual(["find_options", "preview_panel"]);
    expect(req.instructions).toContain('source "notices"');
    expect(calls.find((c) => c.url.endsWith("/ai_resolve_route"))?.body).toMatchObject({ p_feature: "dashboard_builder" });
    expect(calls.find((c) => c.url.endsWith("/ai_log_usage"))?.body).toMatchObject({
      p_module: "dashboards",
      p_kind: "dashboard_builder",
      p_cost: 0.03,
    });
  });

  it("colaborador não monta painel do Mural de avisos", async () => {
    const { d, llm, tools } = deps(async (req) => {
      await req.execute("preview_panel", { spec: { viz: "stat", queries: [{ source: "notices", metric: "seen" }] } });
      return '{"reply":"ok"}';
    }, { role: "member" });
    await handleDashboardBuilder({ company, messages: [], dashboard }, token, env, d);
    expect(tools[0]).toMatch(/Painel inválido: .*notices/);
    expect((llm.mock.calls[0] as unknown as [AgentRequest])[0].instructions).not.toContain('source "notices"');
  });

  it("com a MAVI desligada para a pessoa, não roda", async () => {
    const { d, llm } = deps(async () => "{}", { hidden_pages: ["assistant"] });
    const res = await handleDashboardBuilder({ company, messages: [], dashboard }, token, env, d);
    expect(res.status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
  });
});
