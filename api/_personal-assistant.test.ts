import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import {
  ASSISTANT_INSTRUCTIONS,
  draftMessage,
  handlePersonalDraft,
  parseDraft,
  type DraftMaterial,
} from "./_personal-assistant";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const item = "00000000-0000-4000-8000-0000000000e1";
const rec = "00000000-0000-4000-8000-0000000000a1";
const recShared = "00000000-0000-4000-8000-0000000000a2";
const file = "00000000-0000-4000-8000-0000000000f1";
const fileLocked = "00000000-0000-4000-8000-0000000000f2";
const campaign = "00000000-0000-4000-8000-0000000000c1";
const user = "00000000-0000-4000-8000-000000000011";
const ORIGIN = "https://app.example.com";
const env: AiEnv & { origin: string } = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
  origin: ORIGIN,
};
// Um JWT só com o sub (buildContext lê quem pergunta dele).
const token = `x.${Buffer.from(JSON.stringify({ sub: user })).toString("base64url")}.y`;
const auth = `Bearer ${token}`;

function material(): DraftMaterial {
  return {
    status: "claimed",
    item: {
      id: item,
      kind: "request",
      title: "Relatório de setembro com os leads por dia",
      summary: "Para a reunião de sexta com a diretoria.",
      urgency: 2,
      asks: 2,
      client_id: client,
      client_name: "3110",
      group: "3110 - Clínica Vida",
      first_at: "01/10/2026 09:12",
      reason: "Você cuida dos relatórios",
      task: { id: "t1", title: "Fechar relatório de setembro", status: "progress" },
    },
    quotes: [{ role: "client", who: "Fernanda", text: "Me manda o relatório de setembro?", at: "01/10 09:12" }],
    conversation: [
      { role: "client", who: "Fernanda", text: "Bom dia!", at: "01/10 09:10" },
      { role: "client", who: "Fernanda", text: "Me manda o relatório de setembro?", at: "01/10 09:12" },
    ],
    person: { name: "Bruno Tráfego", about: "Campanhas e relatórios.", teams: ["Tráfego"] },
    style: ["Oi Fe! Tudo certo por aqui 😊"],
    feedback: [
      { action: "training", note: "Sempre cite o período dos números." },
      { action: "rejected", reason: "wrong_tone", note: "Muito formal.", title: "CPL alto" },
      { action: "edited", title: "Logo", draft: "Prezado cliente", final: "Oi Carlos" },
    ],
    guidance: "Mais curto.",
    previous: "Olá Fernanda, segue o relatório.",
    shareables: {
      recordings: [
        { id: rec, title: "Alinhamento", at: "25/09/2026" },
        { id: recShared, title: "Kickoff", at: "01/09/2026", token: "tok-rec" },
      ],
      files: [
        { id: file, name: "leads.xlsx", type: "x", folder: "Relatórios", at: "30/09/2026", can_share: true },
        { id: fileLocked, name: "contrato.pdf", type: "pdf", at: "01/08/2026", can_share: false },
      ],
      campaigns: [
        {
          id: campaign,
          name: "Leads Clínica",
          platform: "meta",
          status: "active",
          cycle: { start: "2026-10-01", end: "2026-10-31", objective: "lead" },
          previous: { start: "2026-09-01", end: "2026-09-30", objective: "lead" },
          reports: [{ id: "r1", title: "Agosto", start: "2026-08-01", end: "2026-08-31", token: "tok-rep" }],
        },
      ],
    },
  };
}

describe("o pedido para a MAVI", () => {
  it("leva a situação, a conversa, o tom, os retornos e os links possíveis", () => {
    const { text, refs } = draftMessage(material(), ORIGIN);
    expect(text).toMatch(/Pessoa: Bruno Tráfego \(equipes: Tráfego\) — o que é com ela: Campanhas e relatórios\./);
    expect(text).toMatch(/Situação \(solicitação, urgente, o cliente cobrou 2x, desde 01\/10\/2026 09:12\)/);
    expect(text).toMatch(/Tarefa aberta sobre isso: "Fechar relatório de setembro"/);
    expect(text).toMatch(/G1 gravação "Alinhamento" de 25\/09\/2026 — dá para criar o link/);
    expect(text).toMatch(/G2 gravação "Kickoff" .* já tem link: https:\/\/app\.example\.com\/gravacao\/tok-rec/);
    expect(text).toMatch(/F2 arquivo "contrato\.pdf" .* sem link \(a pessoa não pode compartilhar\)/);
    expect(text).toMatch(/C1 campanha "Leads Clínica" \(meta, ativa\) · ciclo atual 01\/10\/2026 a 31\/10\/2026 · anterior 01\/09\/2026 a 30\/09\/2026/);
    expect(text).toMatch(/"Agosto" \(01\/08\/2026 a 31\/08\/2026\) https:\/\/app\.example\.com\/relatorio\/tok-rep/);
    expect(text).toMatch(/Como a pessoa escreve.*\n- "Oi Fe! Tudo certo por aqui 😊"/);
    expect(text).toMatch(/- Instrução: Sempre cite o período dos números\./);
    expect(text).toMatch(/- Reprovou uma resposta \(tom errado\): Muito formal\. — situação "CPL alto"/);
    expect(text).toMatch(/- Editou antes de mandar \("Logo"\): de "Prezado cliente" para "Oi Carlos"/);
    expect(text).toMatch(/A versão anterior desta resposta \(melhore\):\n"Olá Fernanda, segue o relatório\."/);
    expect(text).toMatch(/Pedido da pessoa para esta versão: Mais curto\./);
    expect(refs.campaigns.get("C1")?.id).toBe(campaign);
  });
});

describe("respostas menos repetidas e a base do robô", () => {
  const prompt = "00000000-0000-4000-8000-0000000000b1";
  const withExtras = (): DraftMaterial => ({
    ...material(),
    product: "MAVI",
    team_examples: ["Oi! Já ajustamos o robô para responder o horário novo."],
    lessons: [
      { scope: "person", text: "Sem emojis." },
      { scope: "product", text: "Em ajuste no robô, diga quando entra no ar." },
    ],
    knowledge: [
      {
        id: prompt,
        workflow: "3110 - Atendimento",
        node: "AI Agent",
        full: true,
        chars: 60,
        text: "Você é a Vida. Atendemos de segunda a sexta, das 8h às 18h.",
      },
    ],
  });

  it("o tom é só tom, os exemplos do produto são conteúdo, e a base entra numerada", () => {
    const { text, refs } = draftMessage(withExtras(), ORIGIN);
    expect(text).toMatch(/grupo "3110 - Clínica Vida" · produto MAVI\./);
    expect(text).toMatch(/Como a pessoa escreve \(respostas que ela mandou; só o tom — não copie frases nem a estrutura\):/);
    expect(text).toMatch(/Respostas aprovadas de colegas em situações do produto MAVI \(referência do que costuma ser respondido, não do tom\):\n- "Oi! Já ajustamos/);
    expect(text).toMatch(/Base do Agente Conversacional do cliente .*\n\[K1\] fluxo "3110 - Atendimento" › nó "AI Agent"\nVocê é a Vida/);
    expect(text).toMatch(/- Do produto: Em ajuste no robô, diga quando entra no ar\./);
    expect(refs.knowledge.get("K1")?.id).toBe(prompt);
  });

  it("a evidência da base diz de onde veio", () => {
    const { refs } = draftMessage(withExtras(), ORIGIN);
    const draft = parseDraft(
      JSON.stringify({
        reply: "Oi Fernanda! O robô já informa: de segunda a sexta, das 8h às 18h.",
        evidence: [
          { title: "Horário no robô", detail: "Atendemos de segunda a sexta, das 8h às 18h.", source: "K1" },
          { title: "Inventado", detail: "Atendemos sábado", source: "K1" },
        ],
      }),
      refs,
      [],
    );
    expect(draft.evidence[0]).toEqual({
      title: "Horário no robô",
      detail: "Atendemos de segunda a sexta, das 8h às 18h. (Agente Conversacional: 3110 - Atendimento › AI Agent)",
    });
    expect(draft.evidence[1].detail).toMatch(/confira o trecho\)$/);
  });

  it("a regra pede para não copiar os exemplos e usar a base", () => {
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/não copie frases, aberturas, despedidas nem a estrutura/);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/base do Agente Conversacional do cliente/);
  });
});

describe("a tarefa sugerida", () => {
  const ana = "00000000-0000-4000-8000-000000000021";
  const criacao = "00000000-0000-4000-8000-000000000031";
  const contract = "00000000-0000-4000-8000-000000000041";
  const withTask = (): DraftMaterial => ({
    ...material(),
    task_context: {
      people: [
        { id: user, name: "Bruno Tráfego", teams: ["Tráfego"], me: true },
        { id: ana, name: "Ana Design", teams: ["Criação"], about: "Artes e criativos." },
      ],
      teams: [{ id: criacao, name: "Criação", members: ["Ana Design"] }],
      contracts: [{ id: contract, product: "Make Ads", product_id: "p1" }],
      product_id: "p1",
      open_tasks: [{ title: "Trocar público da campanha", status: "progress", assignee: "Bruno Tráfego" }],
    },
    lessons: [{ scope: "product", kind: "task", text: "Troca de arte vira tarefa da Criação." }],
  });

  it("a MAVI vê quem atende o cliente, os produtos, as tarefas abertas e quando sugerir", () => {
    const { text } = draftMessage(withTask(), ORIGIN);
    expect(text).toMatch(/pessoas que atendem o cliente \(P#\):\n- P1 Bruno Tráfego \(a própria pessoa\) · equipes: Tráfego\n- P2 Ana Design · equipes: Criação · o que é com ela: Artes e criativos\./);
    expect(text).toMatch(/- E1 Criação \(Ana Design\)/);
    expect(text).toMatch(/- Q1 Make Ads \(o da situação\)/);
    expect(text).toMatch(/Tarefas abertas do cliente:\n- Trocar público da campanha \(progress, com Bruno Tráfego\)/);
    expect(text).toMatch(/Quando sugerir tarefa \(o que você aprendeu; siga\):\n- Do produto: Troca de arte vira tarefa da Criação\./);
    expect(ASSISTANT_INSTRUCTIONS).toMatch(/A tarefa \("task"\), SÓ quando a situação pede trabalho operacional/);
  });

  it("troca as referências pelos ids; pessoa vale mais que equipe; sem título ou fora da lista, nada", () => {
    const { refs } = draftMessage(withTask(), ORIGIN);
    const draft = parseDraft(
      JSON.stringify({
        reply: "Oi! Já pedi a arte nova.",
        task: { title: "Criar arte nova do post", description: "O cliente pediu.", assignee: "P2", team: "E1", product: "Q1", due: "2026-10-09", priority: "high", why: "Precisa de arte." },
      }),
      refs,
      [],
    );
    expect(draft.task).toEqual({
      title: "Criar arte nova do post",
      description: "O cliente pediu.",
      assignee_id: ana,
      contract_id: contract,
      due: "2026-10-09",
      priority: "high",
      why: "Precisa de arte.",
    });
    const team = parseDraft(JSON.stringify({ reply: "Oi!", task: { title: "Criar arte", team: "E1", assignee: "P9", priority: "max" } }), refs, []);
    expect(team.task).toEqual({ title: "Criar arte", team_id: criacao });
    expect(parseDraft(JSON.stringify({ reply: "Oi!", task: { title: "x" } }), refs, []).task).toBeNull();
    expect(parseDraft(JSON.stringify({ reply: "Oi!", task: null }), refs, []).task).toBeNull();
  });
});

describe("a resposta da MAVI, conferida", () => {
  const { refs } = draftMessage(material(), ORIGIN);
  const sources = [{ ref: "S1", type: "campaign" as const, id: campaign, title: "Leads Clínica", date: "2026-09-30" }];

  it("links só da lista; marcador sem link sai do texto; fontes trocadas pelas da busca", () => {
    const d = parseDraft(
      JSON.stringify({
        reply: "Oi Fe! Segue o relatório de setembro: {{A1}} e a planilha {{A2}}. A gravação: {{A3}} {{A4}}",
        evidence: [
          { title: "Setembro", detail: "312 leads a R$ 14,20", source: "[S1]" },
          { title: "Sem fonte", detail: "x", source: "S9" },
          { title: "", detail: "" },
        ],
        actions: [
          { key: "A1", ref: "C1", period: "previous", label: "Relatório de setembro" },
          { key: "A2", ref: "F1" },
          // Gravação que já tem link e arquivo que ela não pode compartilhar: não viram ação.
          { key: "A3", ref: "G2" },
          { key: "A4", ref: "F2" },
          { key: "A1", ref: "G1" },
          { key: "x", ref: "G1" },
        ],
        checks: ["Confira o total de leads de hoje."],
        confidence: "medium",
      }),
      refs,
      sources,
    );
    expect(d.actions).toEqual([
      {
        key: "A1",
        kind: "report",
        id: campaign,
        label: "Relatório de setembro",
        platform: "meta",
        start: "2026-09-01",
        end: "2026-09-30",
        objective: "lead",
      },
      { key: "A2", kind: "file", id: file, label: "leads.xlsx" },
    ]);
    expect(d.reply).toBe("Oi Fe! Segue o relatório de setembro: {{A1}} e a planilha {{A2}}. A gravação:");
    expect(d.checks).toEqual([
      "Confira o total de leads de hoje.",
      "A MAVI quis colocar um link que não está disponível: confira se falta algum.",
    ]);
    expect(d.evidence).toEqual([
      { title: "Setembro", detail: "312 leads a R$ 14,20", source: sources[0] },
      { title: "Sem fonte", detail: "x" },
    ]);
    expect(d.confidence).toBe("medium");
  });

  it("período próprio do relatório e o ciclo atual por padrão", () => {
    const d = parseDraft(
      JSON.stringify({
        reply: "{{A1}} {{A2}}",
        actions: [
          { key: "A1", ref: "C1", period: { start: "2026-09-15", end: "2026-09-30" } },
          { key: "A2", ref: "C1" },
        ],
      }),
      refs,
      [],
    );
    expect(d.actions.map((a) => (a.kind === "report" ? [a.start, a.end] : null))).toEqual([
      ["2026-09-15", "2026-09-30"],
      ["2026-10-01", "2026-10-31"],
    ]);
  });

  it("sem JSON ou sem texto, falha (e a resposta volta para a fila)", () => {
    expect(() => parseDraft("não sei", refs, [])).toThrow(/não devolveu/);
    expect(() => parseDraft('{"reply":"  "}', refs, [])).toThrow(/vazia/);
  });
});

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
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

const baseRoutes = {
  "rest/v1/memberships": [{ user_id: user, name: "Bruno Tráfego", email: "b@x", role: "member", active: true, hidden_pages: [], shown_pages: [] }],
  "rest/v1/clients": [{ id: client, name: "3110" }],
  "rest/v1/contracts": [],
  "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
  "rpc/ai_resolve_route": null,
};

describe("personal-radar-draft", () => {
  it("sem login, recusa", async () => {
    const res = await handlePersonalDraft({ company }, null, env, { fetch: vi.fn() as any, llm: vi.fn(), embed: vi.fn() });
    expect(res.status).toBe(401);
  });

  it("sem item, pega o próximo da fila; fila vazia, nada a fazer", async () => {
    const { fetchImpl, calls } = database({ ...baseRoutes, "rpc/personal_radar_draft_next": null });
    const llm = vi.fn();
    const res = await handlePersonalDraft({ company }, auth, env, { fetch: fetchImpl, llm, embed: vi.fn() });
    expect(res.body).toEqual({ status: "none" });
    expect(llm).not.toHaveBeenCalled();
    expect(calls[0].auth).toBe(auth);
  });

  it("já pronta ou sendo escrita: não chama a MAVI", async () => {
    const { fetchImpl } = database({ ...baseRoutes, "rpc/personal_radar_draft_start": { status: "running" } });
    const llm = vi.fn();
    const res = await handlePersonalDraft({ company, item }, auth, env, { fetch: fetchImpl, llm, embed: vi.fn() });
    expect(res.body).toEqual({ status: "running", item });
    expect(llm).not.toHaveBeenCalled();
  });

  it("escreve com o login da pessoa, com as ferramentas de leitura, e grava a resposta e o custo", async () => {
    const { fetchImpl, calls } = database({
      ...baseRoutes,
      "rpc/personal_radar_draft_start": material(),
      "rpc/personal_radar_draft_store": (b: any) => ({ id: b.p_item, reply: { status: "done", text: b.p_draft.reply } }),
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/MAVI Assistente Pessoal/);
      expect(req.instructions).toMatch(/nunca escreve no grupo/);
      expect(req.context).toMatch(/cliente "3110"/);
      expect(req.tools.map((t) => t.name).sort()).toEqual(
        ["campaign_results", "client_overview", "client_radar", "client_temperature", "list_meetings", "list_tasks", "media_account", "read_more", "search_knowledge"],
      );
      // Ferramenta fora da lista não roda.
      expect(await req.execute("find_clients", {})).toMatch(/indisponível/);
      const meter = newMeter("claude-opus-5-5");
      meter.input = 12000;
      meter.output = 500;
      meter.cost = 0.09;
      return {
        text: JSON.stringify({
          reply: "Oi Fe! Segue o relatório de setembro: {{A1}}",
          actions: [{ key: "A1", ref: "C1", period: "previous", label: "Relatório de setembro" }],
          evidence: [{ title: "Setembro", detail: "312 leads" }],
          confidence: "high",
        }),
        meter,
        rounds: 1,
      };
    });
    const res = await handlePersonalDraft({ company, item, force: true, guidance: "Mais curto." }, auth, env, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: item, reply: { status: "done", text: "Oi Fe! Segue o relatório de setembro: {{A1}}" } });
    const start = calls.find((c) => c.url.includes("rpc/personal_radar_draft_start"))!;
    expect(start.body).toEqual({ p_company: company, p_item: item, p_force: true, p_guidance: "Mais curto." });
    expect(start.auth).toBe(auth);
    const store = calls.find((c) => c.url.includes("rpc/personal_radar_draft_store"))!;
    expect(store.auth).toBe(auth);
    expect(store.body.p_draft.actions[0]).toMatchObject({ kind: "report", start: "2026-09-01", end: "2026-09-30" });
    expect(store.body.p_usage).toMatchObject({ model: "claude-opus-5-5", input: 12000, output: 500, cost: 0.09 });
    expect(calls.some((c) => c.url.includes("rpc/personal_radar_draft_fail"))).toBe(false);
  });

  it("usa os exemplos parecidos, as lições do produto e a base do robô do cliente", async () => {
    const product = "00000000-0000-4000-8000-0000000000d1";
    const { fetchImpl, calls } = database({
      ...baseRoutes,
      "rpc/personal_radar_draft_start": material(),
      "rpc/personal_radar_reply_examples": { product: "MAVI", product_id: product, mine: ["Fala, Fe!"], team: ["Ajustado."] },
      "rpc/personal_radar_reply_lessons": [{ scope: "product", text: "Diga quando entra no ar." }],
      "rpc/agent_knowledge": [{ id: "k", workflow: "3110", node: "AI Agent", full: true, chars: 10, text: "Você é a Vida." }],
      "rpc/personal_radar_draft_store": (b: any) => ({ id: b.p_item }),
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      const text = req.messages[0].content;
      expect(text).toMatch(/- "Fala, Fe!"/);
      expect(text).not.toMatch(/Oi Fe! Tudo certo por aqui/);
      expect(text).toMatch(/colegas em situações do produto MAVI[\s\S]*- "Ajustado\."/);
      expect(text).toMatch(/- Do produto: Diga quando entra no ar\./);
      expect(text).toMatch(/\[K1\] fluxo "3110" › nó "AI Agent"\nVocê é a Vida\./);
      return { text: JSON.stringify({ reply: "Oi!" }), meter: newMeter("x"), rounds: 1 };
    });
    const res = await handlePersonalDraft({ company, item }, auth, env, { fetch: fetchImpl, llm, embed: vi.fn() });
    expect(res.status).toBe(200);
    const lessons = calls.find((c) => c.url.includes("rpc/personal_radar_reply_lessons"))!;
    expect(lessons.body).toEqual({ p_company: company, p_client: client, p_product: product });
    const kb = calls.find((c) => c.url.includes("rpc/agent_knowledge"))!;
    expect(kb.auth).toBe(auth);
    expect(kb.body).toMatchObject({ p_company: company, p_client: client, p_chars: 16000 });
    expect(kb.body.p_query).toMatch(/Relatório de setembro/);
  });

  it("no limite de gasto da MAVI ou com erro do modelo, a resposta volta para a fila", async () => {
    const { fetchImpl, calls } = database({
      ...baseRoutes,
      "rpc/personal_radar_draft_start": material(),
      "rpc/ai_check_limits": { blocked: true, message: "Limite do mês atingido.", warnings: [] },
    });
    const res = await handlePersonalDraft({ company, item }, auth, env, { fetch: fetchImpl, llm: vi.fn(), embed: vi.fn() });
    expect(res).toEqual({ status: 429, body: { error: "Limite do mês atingido." } });
    const fail = calls.find((c) => c.url.includes("rpc/personal_radar_draft_fail"))!;
    expect(fail.body).toEqual({ p_company: company, p_item: item, p_error: "Limite do mês atingido." });
  });
});
