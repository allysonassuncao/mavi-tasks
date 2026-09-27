import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import {
  alertReader,
  copilotRelated,
  dossierContext,
  handleDossierWorker,
  parseDossierOps,
  readDraft,
  related,
  streamCopilot,
  type CopilotEvent,
  type DossierEnv,
} from "./_copilot";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const me = "00000000-0000-4000-8000-000000000003";
const contract = "00000000-0000-4000-8000-000000000005";
const taskA = "00000000-0000-4000-8000-00000000000a";
const caseA = "00000000-0000-4000-8000-00000000000c";
const item1 = "00000000-0000-4000-8000-0000000000d1";
const token = (sub: string) =>
  `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-sonnet-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
};

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url,
      body,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    if (!key) return new Response("[]", { status: 200 });
    const value = routes[key];
    const data =
      typeof value === "function"
        ? (value as (b: any) => unknown)(body)
        : value;
    return new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const embed = vi.fn(async (texts: string[]) => ({
  vectors: texts.map(() => Array.from({ length: 1536 }, (_, i) => (i ? 0 : 1))),
  tokens: 50,
  model: "text-embedding-3-small",
}));

const context = {
  throttled: false,
  client: { id: client, name: "ACME" },
  contract,
  product: "Social Media",
  similar: [
    {
      id: taskA,
      title: "Post de Black Friday no feed",
      status: "progress",
      assignee: me,
      due: "2026-10-02",
      date: "2026-09-20T12:00:00Z",
      snippet: "Carrossel com a oferta de 30%",
      similarity: 0.81,
    },
    {
      id: "00000000-0000-4000-8000-00000000000e",
      title: "Black Friday da diretoria",
      status: "review",
      restricted: true,
      similarity: 0.8,
    },
    {
      id: "00000000-0000-4000-8000-00000000000b",
      title: "Relatório mensal",
      status: "done",
      assignee: null,
      due: null,
      date: null,
      snippet: "",
      similarity: 0.2,
    },
  ],
  cases: [
    {
      id: caseA,
      title: "Loja X dobrou vendas",
      date: null,
      snippet: "ROAS 8",
      similarity: 0.5,
    },
  ],
  evidence: [
    {
      type: "whatsapp",
      id: "00000000-0000-4000-8000-0000000000e1",
      title: "ACME · Grupo · 10/09/2026",
      date: "2026-09-10T12:00:00Z",
      meta: {
        group: "00000000-0000-4000-8000-0000000000f1",
        message: "00000000-0000-4000-8000-0000000000f2",
        at: "2026-09-10T15:00:00Z",
      },
      contract: null,
      content: "cabeçalho\nCliente: não usem vermelho nas artes, por favor",
    },
  ],
  dossier: {
    version: 3,
    built_at: "2026-09-26T00:00:00Z",
    items: [
      {
        id: item1,
        kind: "avoids",
        text: "Não gosta de vermelho nas artes",
        origin: "person" as const,
        pinned: true,
        seen_at: "2026-09-10T00:00:00Z",
      },
    ],
  },
};

describe("rascunho", () => {
  it("exige empresa, produto (ou tarefa) e um pouco de texto", () => {
    expect(() => readDraft({ company: "x" })).toThrow("Empresa");
    expect(() => readDraft({ company })).toThrow("cliente");
    expect(() => readDraft({ company, contract, title: "Post" })).toThrow(
      "Escreva",
    );
    const d = readDraft({
      company,
      contract,
      title: "Post de Black Friday",
      description: "x".repeat(9000),
      due: "amanhã",
    });
    expect(d.description).toHaveLength(6000);
    expect(d.due).toBe("");
  });
});

describe("Relacionados", () => {
  it("mostra só o que passa da semelhança e marca a possível duplicada", () => {
    const r = related(context);
    expect(r.similar.map((t) => t.id)).toEqual([
      taskA,
      "00000000-0000-4000-8000-00000000000e",
    ]);
    expect(r.similar[0].duplicate).toBe(true);
    expect(r.cases).toHaveLength(1);
  });

  it("uma ida ao banco, como a pessoa, sem chamar modelo", async () => {
    const { fetchImpl, calls } = database({
      "rpc/task_copilot_context": context,
    });
    const llm = vi.fn();
    const res = await copilotRelated(
      { company, contract, title: "Post de Black Friday no feed" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed },
    );
    expect(res.status).toBe(200);
    expect(llm).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBe(token(me));
    expect(calls[0].body.p_review).toBe(false);
    expect(calls[0].body.p_embedding).toMatch(/^\[1,0,/);
  });
});

describe("leitura dos alertas", () => {
  const sources = [
    {
      ref: "S1",
      type: "task" as const,
      id: taskA,
      title: "t",
      date: null,
      client_id: client,
    },
  ];
  it("cada linha completa vira um alerta, mesmo chegando aos pedaços", () => {
    const got: string[] = [];
    const r = alertReader(context, sources, (a) => got.push(a.title));
    r.push(
      '{"kind":"duplicate","severity":"high","title":"Já existe","text":"Veja [S1]","refs":["S1"]}\n{"kind":"avo',
    );
    expect(got).toEqual(["Já existe"]);
    r.push(
      'ids","title":"Sem vermelho","text":"O cliente pediu","fix":"Não usar vermelho [D1].","refs":["[D1]"]}',
    );
    const all = r.end();
    expect(got).toEqual(["Já existe", "Sem vermelho"]);
    expect(all[0].text).toBe("Veja");
    expect(all[0].sources[0].id).toBe(taskA);
    expect(all[1].severity).toBe("medium");
    expect(all[1].fix).toBe("Não usar vermelho.");
    expect(all[1].dossier[0].id).toBe(item1);
  });

  it("descarta alerta sem base, tipo desconhecido, JSON quebrado e passa de 5", () => {
    const r = alertReader(context, sources, () => {});
    r.push('{"kind":"suggestion","title":"Genérico","text":"x","refs":[]}\n');
    r.push('{"kind":"missing","title":"Falta o formato","text":"x"}\n');
    r.push(
      '{"kind":"outro","title":"?","refs":["S1"]}\n{quebrado\n{"ok":true}\n',
    );
    for (let i = 0; i < 6; i++)
      r.push(`{"kind":"error","title":"E${i}","text":"x","refs":["S1"]}\n`);
    const all = r.end();
    expect(all.map((a) => a.title)).toEqual([
      "Falta o formato",
      "E0",
      "E1",
      "E2",
      "E3",
    ]);
  });

  it("o dossiê abre o prompt (igual para todos do cliente)", () => {
    const text = dossierContext(context);
    expect(text).toContain("[D1] Não gosta · fixado");
    expect(text).not.toContain("Black Friday");
  });
});

describe("análise em tempo real", () => {
  function setup(over: Record<string, unknown> = {}) {
    return database({
      "memberships?": [{ hidden_pages: [] }],
      "rpc/task_copilot_context": context,
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_log_usage": null,
      ...over,
    });
  }
  const body = {
    company,
    contract,
    title: "Post de Black Friday no feed",
    description: "Arte em vermelho com a oferta",
  };

  it("Relacionados primeiro, depois os alertas um a um, custo registrado", async () => {
    const { fetchImpl, calls } = setup();
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (req) => {
      request = req;
      req.onEvent?.({
        type: "text",
        text: '{"kind":"avoids","severity":"high","title":"Sem vermelho","text":"O cliente não gosta","refs":["D1","S4"]}\n',
      });
      req.onEvent?.({
        type: "text",
        text: '{"kind":"duplicate","severity":"high","title":"Já em andamento","text":"x","refs":["S1","S2"]}',
      });
      const meter = newMeter("claude-sonnet-5");
      meter.input = 1000;
      meter.output = 100;
      meter.cost = 0.01;
      return { text: "", meter, rounds: 0 };
    };
    const events: CopilotEvent[] = [];
    await streamCopilot(
      body,
      token(me),
      env,
      { fetch: fetchImpl, llm, embed },
      (e) => events.push(e),
    );
    expect(events.map((e) => e.type)).toEqual([
      "related",
      "status",
      "alert",
      "alert",
      "done",
    ]);
    const done = events.at(-1) as Extract<CopilotEvent, { type: "done" }>;
    expect(done.version).toBe(3);
    expect(done.alerts[0].sources.map((s) => s.type)).toEqual(["whatsapp"]);
    expect(done.alerts[1].sources[0].id).toBe(taskA);
    // A tarefa do colega vira citação sem atalho, só com título e status.
    expect(done.alerts[1].sources[1]).toMatchObject({
      title: "Black Friday da diretoria",
      restricted: true,
    });
    expect(done.alerts[0].sources[0].restricted).toBeUndefined();
    // Uma chamada, sem ferramentas; o dossiê no contexto em cache e o rascunho na mensagem.
    expect(request!.tools).toEqual([]);
    expect(request!.cacheContext).toBe(true);
    expect(request!.effort).toBe("low");
    expect(request!.context).toContain("Não gosta de vermelho");
    expect(request!.messages[0].content).toContain("Arte em vermelho");
    expect(request!.messages[0].content).toContain(
      '[S1] Tarefa "Post de Black Friday no feed"',
    );
    expect(request!.messages[0].content).toContain(
      '[S2] Tarefa "Black Friday da diretoria" · Em validação',
    );
    expect(request!.messages[0].content).toContain(
      "colega que quem cria não acessa",
    );
    expect(request!.messages[0].content).toContain("[S3] Case de sucesso");
    const log = calls.find((c) => c.url.includes("rpc/ai_log_usage"))!;
    expect(log.body).toMatchObject({
      p_module: "tasks",
      p_kind: "copilot",
      p_client: client,
      p_embedding: 50,
    });
    expect(log.body.p_cost).toBeGreaterThan(0.01);
  });

  it("freio por pessoa: não chama o modelo", async () => {
    const { fetchImpl } = setup({
      "rpc/task_copilot_context": { throttled: true },
    });
    const llm = vi.fn();
    const events: CopilotEvent[] = [];
    await streamCopilot(
      body,
      token(me),
      env,
      { fetch: fetchImpl, llm, embed },
      (e) => events.push(e),
    );
    expect(events).toEqual([{ type: "throttled" }]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("MAVI desligada para a pessoa ou limite de gasto: erro sem chamar o modelo", async () => {
    const llm = vi.fn();
    const off = setup({ "memberships?": [{ hidden_pages: ["assistant"] }] });
    const events: CopilotEvent[] = [];
    await streamCopilot(
      body,
      token(me),
      env,
      { fetch: off.fetchImpl, llm, embed },
      (e) => events.push(e),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", status: 403 });
    const blocked = setup({
      "rpc/ai_check_limits": { blocked: true, message: "Limite do cliente." },
    });
    const more: CopilotEvent[] = [];
    await streamCopilot(
      body,
      token(me),
      env,
      { fetch: blocked.fetchImpl, llm, embed },
      (e) => more.push(e),
    );
    expect(more.at(-1)).toEqual({
      type: "error",
      status: 429,
      error: "Limite do cliente.",
    });
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("dossiê (worker)", () => {
  const denv: DossierEnv = { ...env, dossierModel: "claude-sonnet-5" };
  const material = {
    docs: [
      {
        type: "meeting",
        title: "R1",
        date: "2026-09-01T10:00:00Z",
        text: "Cliente odeia stories longos",
      },
      {
        type: "whatsapp",
        title: "Grupo",
        date: "2026-09-12T10:00:00Z",
        text: "Aprovação sempre com a Bia",
      },
    ],
    cursor_at: "2026-09-26T00:00:00Z",
    cursor_id: "00000000-0000-4000-8000-0000000000aa",
    more: false,
  };

  it("troca as referências pelas fontes e usa a data mais nova", () => {
    const ops = parseDossierOps(
      'ok {"ops":[{"op":"add","kind":"rule","text":"Aprovação com a Bia","refs":["M2","M1"]},{"op":"remove","id":"x"},{"op":"nada"}]}',
      material,
    );
    expect(ops).toHaveLength(2);
    expect(ops[0].sources.map((s) => s.title)).toEqual(["Grupo", "R1"]);
    expect(ops[0].seen_at).toBe("2026-09-12T10:00:00Z");
  });

  it("recusa sem o segredo", async () => {
    const res = await handleDossierWorker("Bearer errado", denv, {
      fetch: vi.fn() as any,
      llm: vi.fn(),
      embed,
    });
    expect(res.status).toBe(401);
  });

  it("lê o material, pede as mudanças e grava com o custo; falha vai para a fila de novo", async () => {
    let claims = 0;
    const clientB = "00000000-0000-4000-8000-0000000000bb";
    const { fetchImpl, calls } = database({
      "rpc/ai_dossier_claim": () =>
        claims++ === 0
          ? [
              {
                client_id: client,
                company_id: company,
                client_name: "ACME",
                products: "Social",
                cursor_at: null,
                cursor_id: null,
                items: [],
              },
              {
                client_id: clientB,
                company_id: company,
                client_name: "BETA",
                products: "",
                cursor_at: null,
                cursor_id: null,
                items: [],
              },
            ]
          : [],
      "rpc/ai_dossier_material": (b: any) =>
        b.p_client === client
          ? material
          : { ...material, docs: [{ ...material.docs[0], text: "quebra" }] },
      "rpc/ai_worker_route": null,
      "rpc/ai_dossier_store": 1,
      "rpc/ai_dossier_fail": null,
    });
    const llm: LlmAdapter = async (req) => {
      const meter = newMeter("claude-sonnet-5");
      meter.cost = 0.02;
      if (req.messages[0].content.includes("quebra"))
        return { text: "sem json", meter, rounds: 0 };
      return {
        text: '{"ops":[{"op":"add","kind":"avoids","text":"Não gosta de stories longos","refs":["M1"]}]}',
        meter,
        rounds: 0,
      };
    };
    const res = await handleDossierWorker(`Bearer ${env.workerSecret}`, denv, {
      fetch: fetchImpl,
      llm,
      embed,
    });
    expect(res.body).toEqual({ clients: 1, changes: 1, failed: 1 });
    const store = calls.find((c) => c.url.includes("rpc/ai_dossier_store"))!;
    expect(store.auth).toBe(`Bearer ${env.supabaseKey}`);
    expect(store.body.p_secret).toBe(env.workerSecret);
    expect(store.body.p_ops[0]).toMatchObject({ op: "add", kind: "avoids" });
    expect(store.body.p_usage).toMatchObject({
      model: "claude-sonnet-5",
      cost: 0.02,
    });
    expect(
      calls.find((c) => c.url.includes("rpc/ai_dossier_fail"))!.body.p_client,
    ).toBe(clientB);
  });
});
