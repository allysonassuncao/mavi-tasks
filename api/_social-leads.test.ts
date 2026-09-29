import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { seal } from "./_google";
import { postTextPlain, slidesRichText } from "../src/social-leads";
import {
  SYSTEM_PROMPT,
  addUsage,
  handleSocialLeads,
  newMeter,
  publicArt,
  planForAdjust,
  planRequest,
  siteDomains,
  withArtText,
  socialLeadsEnv,
  type Deps,
  type ModelRequest,
} from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const contract = "00000000-0000-4000-8000-000000000025";
const planId = "00000000-0000-4000-8000-000000000099";
const env = {
  ...socialLeadsEnv({}),
  anthropicKey: "sk-test",
  supabaseUrl: "https://db.test",
  supabaseKey: "anon",
};
const context = {
  job: "job-1",
  client_name: "Agente Stravitta",
  briefing: {
    clientName: "Agente Stravitta",
    igHandle: "@orenatolive",
    fbHandle: "Criar página",
    websiteUrl: "https://agente.astravitta.com.br/",
    notes: "Não gerar promessas.",
  },
  campaign_objective: "form_nativo",
  responsible: "Lorena Amaral",
  next_month: 1,
  previous: null,
};

/** The database answering each function, and what was called. */
function fakeDb(
  answers: Record<string, (args: any) => { status?: number; body: unknown }>,
) {
  const calls: { name: string; args: any; auth: string | null }[] = [];
  // Which model answers (the MAVI panel) is kept apart from the rest.
  const resolves: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const name = String(url).split("/rpc/")[1];
    const args = JSON.parse(String(init.body));
    if (name === "ai_resolve_route") resolves.push(args);
    else calls.push({ name, args, auth: (init.headers as any).Authorization });
    const a = answers[name]?.(args) ?? { body: null };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, resolves };
}
function deps(
  fetchImpl: typeof fetch,
  replies: string[],
  seen: ModelRequest[] = [],
): Deps & { work: Promise<unknown>[] } {
  const work: Promise<unknown>[] = [];
  return {
    fetch: fetchImpl,
    complete: async (_env, request) => {
      seen.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error("sem resposta");
      return next;
    },
    background: (p) => work.push(p),
    work,
  };
}

describe("provedor e modelo do Painel da MAVI", () => {
  const providerKey = crypto.randomBytes(32);
  const route = {
    scope: "feature",
    provider_id: "00000000-0000-4000-8000-0000000000bb",
    provider: "OpenAI da agência",
    kind: "openai",
    base_url: null,
    key_cipher: seal(providerKey, "sk-da-agencia"),
    model: "gpt-x",
    price: { id: "gpt-x", input: 1, output: 2 },
  };
  it("cada ação pergunta pela sua funcionalidade e usa o provedor escolhido", async () => {
    const { fetchImpl, calls, resolves } = fakeDb({
      ai_resolve_route: () => ({ body: route }),
      social_leads_adjust_context: () => ({
        body: {
          client_name: "ACME",
          briefing: {},
          campaign_objective: null,
          plan: { label: "Mês 1", posts: [] },
        },
      }),
    });
    const used: any[] = [];
    const r = await handleSocialLeads(
      {
        action: "adjust",
        company,
        contract,
        plan: planId,
        instruction: "Troque o gancho do post 2.",
      },
      "Bearer t",
      { ...env, anthropicKey: "", providerKey },
      {
        fetch: fetchImpl,
        complete: async (e, _request, _signal, meter) => {
          used.push(e);
          meter.input = 10;
          return '{"resumo":"ok","alteracoes":{}}';
        },
        background: () => {},
      },
    );
    expect(r.status).toBe(200);
    expect(resolves).toEqual([
      {
        p_company: company,
        p_client: null,
        p_contract: contract,
        p_project: null,
        p_feature: "social_leads_adjust",
      },
    ]);
    expect(used[0].provider).toMatchObject({
      kind: "openai",
      apiKey: "sk-da-agencia",
      model: "gpt-x",
    });
    expect(used[0].model).toBe("gpt-x");
    const log = calls.find((c) => c.name === "social_leads_log_usage");
    expect(log?.args).toMatchObject({ p_kind: "adjust", p_model: "gpt-x" });
  });
  it("sem regra e sem a chave da Vercel, avisa o que falta", async () => {
    const { fetchImpl, calls } = fakeDb({});
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      { ...env, anthropicKey: "" },
      deps(fetchImpl, []),
    );
    expect(r.status).toBe(503);
    expect((r.body as any).error).toContain("Painel da MAVI");
    expect(calls).toEqual([]);
  });
});

describe("geração do plano", () => {
  it("abre a geração, responde na hora e grava o plano como a pessoa", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({ body: { id: planId, version: 1 } }),
    });
    const seen: ModelRequest[] = [];
    const d = deps(fetchImpl, ['{"plano":"ok"}'], seen);
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer user-token",
      env,
      d,
    );
    expect(r).toEqual({ status: 202, body: { job: "job-1" } });
    await Promise.all(d.work);
    expect(calls.map((c) => c.name)).toEqual([
      "social_leads_start_job",
      "social_leads_write_plan",
      "social_leads_finish_job",
    ]);
    expect(calls.every((c) => c.auth === "Bearer user-token")).toBe(true);
    expect(calls[1].args).toMatchObject({
      p_plan: null,
      p_content: { plano: "ok" },
      p_source: "ai",
    });
    expect(calls[2].args).toEqual({
      p_job: "job-1",
      p_plan: planId,
      p_error: null,
    });
    // O site do cliente entra; o Instagram não (pede login).
    expect(seen[0].domains).toEqual(["agente.astravitta.com.br"]);
    expect(seen[0].user).toContain('"notes": "Não gerar promessas."');
  });

  it("pede a quantidade de posts escolhida e confere a resposta", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: { ...context, post_count: 12 } }),
      social_leads_write_plan: () => ({ body: { id: planId, version: 1 } }),
    });
    const seen: ModelRequest[] = [];
    const posts = (n: number) =>
      JSON.stringify({
        posts: Array.from({ length: n }, (_, i) => ({ numero: i + 1 })),
      });
    const d = deps(fetchImpl, [posts(8), posts(12)], seen);
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new", posts: 12 },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(202);
    await Promise.all(d.work);
    expect(calls[0].args).toMatchObject({ p_posts: 12 });
    expect(seen[0].user).toContain(
      "com exatamente 12 posts, numerados de 1 a 12",
    );
    expect(seen[1].user).toContain(
      "precisa de exatamente 12 posts (veio com 8)",
    );
    // Só a segunda resposta, com os 12, chega ao banco.
    expect(
      calls.filter((c) => c.name === "social_leads_write_plan"),
    ).toHaveLength(1);
  });
  it("recusa quantidade fora de 8 a 16", async () => {
    const { fetchImpl, calls } = fakeDb({});
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new", posts: 20 },
      "Bearer t",
      env,
      deps(fetchImpl, []),
    );
    expect(r).toEqual({
      status: 400,
      body: { error: "Escolha de 8 a 16 posts." },
    });
    expect(calls.filter((c) => c.name === "social_leads_start_job")).toEqual(
      [],
    );
  });

  it("pede de novo uma vez quando o banco recusa a estrutura", async () => {
    let writes = 0;
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () =>
        ++writes === 1
          ? {
              status: 400,
              body: { message: "O plano precisa de exatamente 8 posts." },
            }
          : { body: { id: planId, version: 1 } },
    });
    const seen: ModelRequest[] = [];
    const d = deps(fetchImpl, ["{}", "{}"], seen);
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(d.work);
    expect(seen[1].user).toContain(
      "recusada pela validação: O plano precisa de exatamente 8 posts.",
    );
    expect(calls.at(-1)?.args).toEqual({
      p_job: "job-1",
      p_plan: planId,
      p_error: null,
    });
  });

  it("registra a falha na geração para a tela mostrar", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({
        status: 400,
        body: { message: "Post 2 repetido." },
      }),
    });
    const d = deps(fetchImpl, ["{}", "não é json"]);
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(d.work);
    const finish = calls.at(-1)!;
    expect(finish.name).toBe("social_leads_finish_job");
    expect(finish.args.p_error).toMatch(/não passou na validação/);
  });

  it("sem canal e sem cores não chama a IA", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({
        body: { ...context, briefing: { clientName: "X", fbHandle: "criar" } },
      }),
    });
    const d = deps(fetchImpl, []);
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(422);
    expect(d.work).toEqual([]);
    expect(calls.at(-1)?.args.p_error).toMatch(/cores da marca/);
  });

  it("explica o que falta configurar e recusa quem não entrou", async () => {
    const d = deps(fakeDb({}).fetchImpl, []);
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company, contract, mode: "new" },
          "Bearer t",
          { ...env, anthropicKey: "" },
          d,
        )
      ).body,
    ).toEqual({ error: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company, contract, mode: "new" },
          null,
          env,
          d,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSocialLeads(
          { action: "generate", company: "x", contract, mode: "new" },
          "Bearer t",
          env,
          d,
        )
      ).status,
    ).toBe(400);
  });

  it("repassa a recusa do banco (ex.: geração em andamento)", async () => {
    const { fetchImpl } = fakeDb({
      social_leads_start_job: () => ({
        status: 400,
        body: {
          message: "Já existe uma geração em andamento para este cliente.",
        },
      }),
    });
    const r = await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      deps(fetchImpl, []),
    );
    expect(r).toEqual({
      status: 400,
      body: { error: "Já existe uma geração em andamento para este cliente." },
    });
  });
});

describe("pedido de ajuste", () => {
  it("devolve a atualização parcial no contrato do importador", async () => {
    const { fetchImpl } = fakeDb({
      social_leads_adjust_context: () => ({
        body: {
          client_name: "Agente Stravitta",
          briefing: { clientName: "Agente Stravitta" },
          campaign_objective: "ctwa",
          plan: { label: "Mês 1", posts: [] },
        },
      }),
    });
    const seen: ModelRequest[] = [];
    const r = await handleSocialLeads(
      {
        action: "adjust",
        company,
        contract,
        plan: planId,
        instruction: "Post 6 mais leve",
      },
      "Bearer t",
      env,
      deps(
        fetchImpl,
        [
          JSON.stringify({
            resumo: "Post 6 mais leve",
            alteracoes: {
              posts: [{ numero: 6, gancho: "Leve" }],
              publico: null,
              alertas: null,
            },
          }),
        ],
        seen,
      ),
    );
    expect(r).toEqual({
      status: 200,
      body: {
        update: {
          tipo: "social-leads-atualizacao",
          cliente: "Agente Stravitta",
          plano: planId,
          resumo: "Post 6 mais leve",
          alteracoes: { posts: [{ numero: 6, gancho: "Leve" }] },
        },
        cost_usd: 0,
      },
    });
    expect(seen[0].user).toContain("Pedido da equipe: Post 6 mais leve");
    expect(seen[0].domains).toEqual([]);
  });
});

describe("texto da arte por slide", () => {
  const slides = [
    {
      headline: "3 erros na reforma",
      subheadline: "E como evitar",
      texto: "",
      sugestaoImagem: "Foto de uma obra real do cliente.",
    },
    {
      headline: "Erro 1",
      subheadline: "",
      texto: "Pular o projeto.",
      sugestaoImagem: "",
    },
  ];
  it("a geração grava os slides como textoImagem formatado", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({ body: { id: planId, version: 1 } }),
    });
    const d = deps(fetchImpl, [
      JSON.stringify({
        posts: Array.from({ length: 8 }, (_, i) => ({
          numero: i + 1,
          formato: i ? "Reels" : "Carrossel",
          slides: i ? [] : slides,
        })),
      }),
    ]);
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(d.work);
    const posts = calls[1].args.p_content.posts;
    expect(posts[0].slides).toBeUndefined();
    expect(posts[0].textoImagem).toBe(slidesRichText(slides, false));
    expect(postTextPlain(posts[0].textoImagem)).toBe(
      [
        "Slide 1 (Capa)",
        "Headline: 3 erros na reforma",
        "Subheadline: E como evitar",
        "SUGESTÃO DE IMAGEM (só uma ideia para o designer, não vai escrito na arte): Foto de uma obra real do cliente.",
        "",
        "Slide 2",
        "Headline: Erro 1",
        "Texto: Pular o projeto.",
      ].join("\n"),
    );
    expect(posts[1].textoImagem).toBe("");
  });
  it("imagem única vira “Arte”, sem numerar", () => {
    const out = withArtText({
      formato: "Imagem única",
      slides: [slides[0]],
    }) as any;
    expect(postTextPlain(out.textoImagem)).toMatch(/^Arte\nHeadline:/);
  });
  it("o ajuste lê os slides da MAVI e marca o que a equipe editou", () => {
    const edited =
      'mavi:richtext:v1:{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Card 1: editado"}]}]}';
    const plan = planForAdjust({
      posts: [
        {
          numero: 1,
          formato: "Carrossel",
          textoImagem: slidesRichText(slides, false),
        },
        { numero: 2, formato: "Carrossel", textoImagem: edited, legenda: "Oi" },
        {
          numero: 3,
          formato: "Carrossel",
          textoImagem: "(1) Antigo, (2) texto",
        },
      ],
    } as any);
    expect(plan.posts[0]).toMatchObject({ slides });
    expect(plan.posts[0]).not.toHaveProperty("textoImagem");
    expect(plan.posts[0]).not.toHaveProperty("editadosPelaEquipe");
    expect(plan.posts[1]).toMatchObject({
      textoImagem: "Card 1: editado",
      legenda: "Oi",
      editadosPelaEquipe: ["textoImagem"],
    });
    expect(plan.posts[2]).toMatchObject({
      textoImagem: "(1) Antigo, (2) texto",
    });
  });
});

describe("pedido para a IA", () => {
  it("leva as regras e o mês anterior com as decisões", () => {
    expect(SYSTEM_PROMPT).toMatch(/Nunca invente depoimento/);
    expect(SYSTEM_PROMPT).toMatch(/PRIMEIRO alerta é o bloqueio operacional/);
    const r = planRequest(
      {
        ...context,
        campaign_objective: "ctwa",
        next_month: 2,
        previous: {
          label: "Mês 1",
          posts: [
            {
              numero: 1,
              gancho: "G",
              status: "reprovado",
              observacao: "Mais leve",
            },
          ],
          pilares: [],
          alertas: [],
        } as any,
      },
      "new",
    );
    expect(r.user).toContain("Monte o plano do Mês 2 com exatamente 8 posts");
    expect(r.user).toContain('"observacao": "Mais leve"');
    expect(r.user).toContain("Conversa no WhatsApp");
  });
  it("só o domínio do site do cliente", () => {
    expect(siteDomains({ websiteUrl: "www.escola.com.br/matriculas" })).toEqual(
      ["escola.com.br"],
    );
    expect(siteDomains({ websiteUrl: "nao tem" })).toEqual([]);
  });
});

describe("custo da IA", () => {
  it("Opus 5.5: US$ 4 / 20 e leitura de cache a US$ 0,20 (0,05x)", () => {
    const m = newMeter();
    addUsage(m, "claude-opus-5-5", {
      input_tokens: 10_000,
      output_tokens: 8_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 4_000,
    });
    // 10k×4 + 2k×4×1.25 + 4k×0.2 + 8k×20, por milhão.
    expect(m.cost).toBeCloseTo(0.2108, 6);
    // Modelo desconhecido: pelo preço do padrão (Opus 5.5).
    const u = newMeter();
    addUsage(u, "claude-desconhecido", { input_tokens: 1_000_000 });
    expect(u.cost).toBeCloseTo(4, 6);
  });
  it("soma entradas, saídas e cache pelo preço do modelo", () => {
    const m = newMeter();
    addUsage(m, "claude-opus-5", {
      input_tokens: 10_000,
      output_tokens: 8_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 4_000,
    });
    // 10k×5 + 2k×5×1.25 + 4k×5×0.1 + 8k×25, por milhão.
    expect(m.cost).toBeCloseTo(0.2645, 6);
    addUsage(m, "claude-sonnet-5", {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(m.cost).toBeCloseTo(2.2645, 6);
    expect(m.model).toBe("claude-sonnet-5");
  });

  it("a geração registra o custo no plano antes de avisar", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({ body: { id: planId, version: 1 } }),
    });
    const work: Promise<unknown>[] = [];
    const d: Deps = {
      fetch: fetchImpl,
      complete: async (_e, _r, _s, meter) => {
        addUsage(meter, "claude-opus-5", {
          input_tokens: 1000,
          output_tokens: 1000,
        });
        return "{}";
      },
      background: (p) => work.push(p),
    };
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(work);
    expect(calls.map((c) => c.name)).toEqual([
      "social_leads_start_job",
      "social_leads_write_plan",
      "social_leads_log_usage",
      "social_leads_finish_job",
    ]);
    expect(calls[2].args).toMatchObject({
      p_plan: planId,
      p_job: "job-1",
      p_kind: "generate",
      p_input: 1000,
      p_output: 1000,
      p_cost: 0.03,
    });
  });

  it("uma geração que falhou também registra o que gastou", async () => {
    const { fetchImpl, calls } = fakeDb({
      social_leads_start_job: () => ({ body: context }),
      social_leads_write_plan: () => ({
        status: 400,
        body: { message: "Post 2 repetido." },
      }),
    });
    const work: Promise<unknown>[] = [];
    const d: Deps = {
      fetch: fetchImpl,
      complete: async (_e, _r, _s, meter) => {
        addUsage(meter, "claude-opus-5", {
          input_tokens: 1000,
          output_tokens: 0,
        });
        return "{}";
      },
      background: (p) => work.push(p),
    };
    await handleSocialLeads(
      { action: "generate", company, contract, mode: "new" },
      "Bearer t",
      env,
      d,
    );
    await Promise.all(work);
    const log = calls.find((c) => c.name === "social_leads_log_usage")!;
    expect(log.args).toMatchObject({
      p_plan: null,
      p_input: 2000,
      p_cost: 0.01,
    });
  });
});

describe("cores da marca", () => {
  const html = `<html><head><title>Agente Astra</title>
    <meta name="theme-color" content="#0B1D3A">
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="/logo.svg">
    <style>.btn{background:#14b8a6}.x{color:rgba(20,184,166,1)}</style></head>
    <body style="color:#333"></body></html>`;
  const site = (url: string) => {
    if (url === "https://agente.astravitta.com.br/")
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (url.endsWith("/app.css"))
      return new Response(".h{color:#0b1d3a}.a{color:#14B8A6}", {
        headers: { "content-type": "text/css" },
      });
    if (url.endsWith("/logo.svg"))
      return new Response('<svg><path fill="#0e4a6b"/></svg>', {
        headers: { "content-type": "image/svg+xml" },
      });
    return new Response("", { status: 404 });
  };
  const publicDns = async () => ["93.184.216.34"];

  it("lê o site, manda as cores reais para a IA e registra o custo", async () => {
    const db = fakeDb({ social_leads_check_write: () => ({ body: true }) });
    const seen: ModelRequest[] = [];
    const d: Deps = {
      fetch: (async (url: string, init?: RequestInit) =>
        String(url).includes("/rest/v1/rpc/")
          ? db.fetchImpl(url as any, init as any)
          : site(String(url))) as any,
      lookup: publicDns,
      complete: async (_e, request, _s, meter) => {
        seen.push(request);
        addUsage(meter, "claude-opus-5", {
          input_tokens: 800,
          output_tokens: 100,
        });
        return JSON.stringify({
          colors: [
            { hex: "#0B1D3A", name: "Azul-marinho" },
            { hex: "#14b8a6", name: "Verde-água" },
            { hex: "azul", name: "inválida" },
            { hex: "#14b8a6", name: "repetida" },
          ],
          note: "Do site.",
        });
      },
      background: () => {},
    };
    const r = await handleSocialLeads(
      {
        action: "colors",
        company,
        contract,
        website: "agente.astravitta.com.br",
      },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(200);
    expect((r.body as any).colors).toEqual([
      { hex: "#0b1d3a", name: "Azul-marinho" },
      { hex: "#14b8a6", name: "Verde-água" },
    ]);
    // theme-color first, then CSS, inline and the SVG logo's fill.
    expect(seen[0].user).toMatch(/#0b1d3a: 1000/);
    expect(seen[0].user).toMatch(/#14b8a6: 3/);
    expect(seen[0].user).toMatch(/#0e4a6b: 5/);
    expect(db.calls.map((c) => c.name)).toEqual([
      "social_leads_check_write",
      "social_leads_log_usage",
    ]);
    expect(db.calls[1].args).toMatchObject({ p_kind: "colors", p_plan: null });
  });

  it("não abre endereços internos", async () => {
    const db = fakeDb({ social_leads_check_write: () => ({ body: true }) });
    const fetched: string[] = [];
    const d: Deps = {
      fetch: (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/rest/v1/rpc/"))
          return db.fetchImpl(url as any, init as any);
        fetched.push(String(url));
        return new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        });
      }) as any,
      lookup: async (host) =>
        host === "interno.test" ? ["10.0.0.5"] : ["93.184.216.34"],
      complete: async () => "{}",
      background: () => {},
    };
    for (const website of [
      "http://localhost:3000",
      "interno.test",
      "http://127.0.0.1/",
      "ftp://site.com",
    ]) {
      const r = await handleSocialLeads(
        { action: "colors", company, contract, website },
        "Bearer t",
        env,
        d,
      );
      expect(r.status).toBe(422);
    }
    expect(fetched).toEqual([]);
    // A public site that redirects to the metadata address stops there.
    const r = await handleSocialLeads(
      {
        action: "colors",
        company,
        contract,
        website: "https://publico.com.br",
      },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(422);
    expect(fetched).toEqual(["https://publico.com.br/"]);
  });

  it("pede o site ou o Instagram e respeita a permissão", async () => {
    const d = deps(fakeDb({}).fetchImpl, []);
    expect(
      (
        await handleSocialLeads(
          { action: "colors", company, contract },
          "Bearer t",
          env,
          d,
        )
      ).status,
    ).toBe(400);
    const denied = fakeDb({
      social_leads_check_write: () => ({
        status: 403,
        body: { message: "Sem permissão para editar este cliente." },
      }),
    });
    const r = await handleSocialLeads(
      { action: "colors", company, contract, instagram: "@a" },
      "Bearer t",
      env,
      deps(denied.fetchImpl, []),
    );
    expect(r).toEqual({
      status: 403,
      body: { error: "Sem permissão para editar este cliente." },
    });
  });
});

describe("artes no link do cliente", () => {
  const token = "a".repeat(64);
  const file = "00000000-0000-4000-8000-000000000040";
  it("confere o token no banco (sem login) e redireciona para o endereço assinado", async () => {
    const db = fakeDb({
      social_leads_public_art: () => ({
        body: [
          {
            path: "drive/a/art1",
            name: "post1.png",
            content_type: "image/png",
          },
        ],
      }),
    });
    const r = await publicArt(
      new URLSearchParams({ arte: file, link: token }),
      env,
      {
        fetch: db.fetchImpl,
        sign: (f) => `https://storage.test/${f.path}?sig=1`,
      },
    );
    expect(r).toEqual({
      status: 302,
      location: "https://storage.test/drive/a/art1?sig=1",
    });
    expect(db.calls[0]).toMatchObject({
      name: "social_leads_public_art",
      args: { p_token: token, p_file: file },
      auth: "Bearer anon",
    });
  });
  it("não responde a token ou arquivo errados", async () => {
    const db = fakeDb({ social_leads_public_art: () => ({ body: [] }) });
    const sign = () => "https://x";
    expect(
      (
        await publicArt(new URLSearchParams({ arte: file, link: token }), env, {
          fetch: db.fetchImpl,
          sign,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await publicArt(
          new URLSearchParams({ arte: "../x", link: token }),
          env,
          { fetch: db.fetchImpl, sign },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await publicArt(
          new URLSearchParams({ arte: file, link: "curto" }),
          env,
          { fetch: db.fetchImpl, sign },
        )
      ).status,
    ).toBe(404);
    expect(db.calls.length).toBe(1);
  });
});

describe("briefing pela IA", () => {
  const recording = "00000000-0000-4000-8000-000000000077";
  const reply = JSON.stringify({
    fields: {
      clientName: "Agente Stravitta",
      segment: "Escola de idiomas",
      contactWhats: "11 91234-5678",
      averageTicket: "450.00",
      igHandle: "https://instagram.com/agentestravitta/",
      websiteUrl: "agente.astravitta.com.br",
      briefingDate: "",
      competitors: "",
    },
    campaignObjective: "ctwa",
    evidence: [
      { field: "segment", quote: "a gente é uma escola de inglês" },
      { field: "competitors", quote: "não falou" },
    ],
    missing: ["competitors", "segment", "nada"],
    resumo: "Aproveitei nome, segmento e ticket.",
  });

  it("lê a reunião do cliente, formata os campos e registra o custo", async () => {
    const db = fakeDb({
      social_leads_meeting_text: () => ({
        body: {
          title: "Onboarding",
          recorded_at: "2026-09-12T14:00:00Z",
          speakers: ["Lorena", "Renato"],
          segments: [
            [0, 3, 0, "Oi Renato, tudo bem?"],
            [4, 8, 1, "Tudo, a gente é uma escola de inglês."],
            [9, 12, 1, "Ticket de 450 reais."],
          ],
          summary: {},
        },
      }),
    });
    const seen: ModelRequest[] = [];
    const d = deps(db.fetchImpl, [reply], seen);
    const complete = d.complete;
    d.complete = async (e, request, signal, meter) => {
      addUsage(meter, "claude-opus-5", {
        input_tokens: 9000,
        output_tokens: 700,
      });
      return complete(e, request, signal, meter);
    };
    const r = await handleSocialLeads(
      { action: "briefing", company, contract, recording },
      "Bearer t",
      env,
      d,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      fields: {
        clientName: "Agente Stravitta",
        segment: "Escola de idiomas",
        contactWhats: "(11) 91234-5678",
        // O ticket médio é texto livre: fica como a MAVI escreveu.
        averageTicket: "450.00",
        igHandle: "@agentestravitta",
        websiteUrl: "https://agente.astravitta.com.br",
        // No date said: the meeting's day.
        briefingDate: "2026-09-12",
      },
      objective: "ctwa",
      evidence: { segment: "a gente é uma escola de inglês" },
      missing: ["competitors"],
      source: "Onboarding · 12/09/2026",
    });
    expect((r.body as any).fields.competitors).toBeUndefined();
    // The transcript goes to the AI as lines, same speaker joined.
    expect(seen[0].user).toContain(
      "[00:04] Renato: Tudo, a gente é uma escola de inglês. Ticket de 450 reais.",
    );
    expect(seen[0].schema).toBeTruthy();
    expect(db.calls.map((c) => c.name)).toEqual([
      "social_leads_meeting_text",
      "social_leads_log_usage",
    ]);
    expect(db.calls[1].args).toMatchObject({ p_kind: "briefing" });
  });

  it("aceita texto colado, confere quem edita e recusa o vazio", async () => {
    const db = fakeDb({});
    const seen: ModelRequest[] = [];
    const r = await handleSocialLeads(
      {
        action: "briefing",
        company,
        contract,
        text: "Notas: escola de inglês.",
      },
      "Bearer t",
      env,
      deps(db.fetchImpl, [reply], seen),
    );
    expect(r.status).toBe(200);
    expect((r.body as any).source).toBe("Texto colado");
    expect(db.calls[0].name).toBe("social_leads_check_write");
    expect(seen[0].user).toContain("Notas: escola de inglês.");
    const empty = await handleSocialLeads(
      { action: "briefing", company, contract, text: "  " },
      "Bearer t",
      env,
      deps(fakeDb({}).fetchImpl, []),
    );
    expect(empty.status).toBe(400);
    const big = await handleSocialLeads(
      { action: "briefing", company, contract, text: "x".repeat(200_001) },
      "Bearer t",
      env,
      deps(fakeDb({}).fetchImpl, []),
    );
    expect(big.status).toBe(400);
    const denied = await handleSocialLeads(
      { action: "briefing", company, contract, text: "oi" },
      "Bearer t",
      env,
      deps(
        fakeDb({
          social_leads_check_write: () => ({
            status: 403,
            body: { message: "Sem permissão." },
          }),
        }).fetchImpl,
        [],
      ),
    );
    expect(denied.status).toBe(403);
  });
});
