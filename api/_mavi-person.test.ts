import { describe, expect, it, vi } from "vitest";
import { streamAi, type AiEnv } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { handleLearningWorker, type LearningEnv } from "./_copilot-learning";
import {
  memoryNote,
  parsePersonOps,
  personContext,
  personMessage,
  personRefs,
  PERSON_CONTEXT_CHARS,
  withSources,
  type PersonClaim,
} from "./_mavi-person";
import { judgeMessage } from "./_mavi-judge";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-0000000000c9";
const run = "00000000-0000-4000-8000-0000000000e1";
const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5-5",
  openaiKey: "",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};
const lenv: LearningEnv = { ...env, learningModel: "claude-opus-5-5" };

const claim: PersonClaim = {
  company,
  user: me,
  name: "Ana Equipe",
  facts: { role: "member", teams: ["Squad Primogênito"], clients: [{ id: "k1", name: "5022", n: 12 }] },
  items: [
    { id: "00000000-0000-4000-8000-0000000000a1", kind: "preference", text: "Seja direta.", origin: "person", pinned: true, dismissed: false },
    { id: "00000000-0000-4000-8000-0000000000a2", kind: "frustration", text: "Removido.", origin: "mavi", pinned: false, dismissed: true },
  ],
  feedback: [{ vote: "down", reason: "format", comment: "Sempre quero em tabela", question: "Quais clientes estão frios?", answer: "…", at: "" }],
  frustrations: [{ signals: ["frustration"], answer: "Agora vou puxar as reuniões.", said: "Me mande o que te pedi", judge: "Parou no meio." }],
  questions: ["Me mande o que te pedi", "Faça a passagem dos 17 clientes"],
};

describe("base de comportamento · leitura", () => {
  it("mostra o que o sistema sabe, os itens com quem decidiu, as avaliações, as reclamações e as perguntas", () => {
    const m = personMessage(claim);
    expect(m).toContain("Pessoa: Ana Equipe (colaborador) · equipes: Squad Primogênito");
    expect(m).toContain("Clientes que mais consulta com a MAVI (90 dias): 5022 (12)");
    expect(m).toContain("preferência · escrito pela pessoa: Seja direta.");
    expect(m).toContain("frustração · removido: Removido.");
    expect(m).toContain("👎 formato ruim — “Sempre quero em tabela” · pergunta: Quais clientes estão frios?");
    expect(m).toContain("ela disse: “Me mande o que te pedi” · conferência da MAVI: Parou no meio.");
    expect(m).toContain("- [P2] Faça a passagem dos 17 clientes");
    expect(m).toContain("- [A1] 👎");
    expect(m).toContain("- [R1] depois da resposta");
  });

  it("situação: a validade aparece para a MAVI renovar ou aposentar", () => {
    const m = personMessage({
      ...claim,
      items: [
        { ...claim.items[0], id: "s1", kind: "context", text: "Fecha o mês do 5022.", durability: "situation", expired: true },
        { ...claim.items[0], id: "s2", kind: "context", text: "Monta o trimestral.", durability: "situation", valid_until: "2026-12-05T12:00:00Z" },
      ],
    });
    expect(m).toContain("contexto · situação vencida · escrito pela pessoa: Fecha o mês do 5022.");
    expect(m).toContain("contexto · situação até 05/12 · escrito pela pessoa: Monta o trimestral.");
  });

  it("as evidências citadas viram as fontes do item (as que não existem somem)", () => {
    const ops = parsePersonOps(
      '{"ops":[{"op":"add","kind":"preference","text":"Responda em tabela.","durability":"stable","from":["A1","R1","P2","P9","X1",3]},{"op":"update","id":"i1","text":"Novo.","durability":"situation"}]}',
    );
    expect(ops[0].from).toEqual(["A1", "R1", "P2", "P9"]);
    expect(ops[1]).toEqual({ op: "update", id: "i1", text: "Novo.", durability: "situation" });
    const c = {
      ...claim,
      feedback: [{ ...claim.feedback[0], id: 41 }],
      frustrations: [{ ...claim.frustrations[0], message: 77 }],
      question_ids: [90, 91],
    };
    expect(withSources(ops, c)).toEqual([
      {
        op: "add",
        kind: "preference",
        text: "Responda em tabela.",
        durability: "stable",
        sources: [
          { type: "feedback", id: 41 },
          { type: "check", message: 77 },
          { type: "question", message: 91 },
        ],
      },
      { op: "update", id: "i1", text: "Novo.", durability: "situation" },
    ]);
  });

  it("na pergunta: os itens com id ganham [M#]; o que passa do teto fica de fora", () => {
    const p = {
      items: [
        { id: "a", kind: "preference" as const, text: "Responda em tabela." },
        { id: "b", kind: "context" as const, text: "Fecha o mês do 5022.", durability: "situation" as const },
        { id: "c", kind: "frustration" as const, text: "x".repeat(PERSON_CONTEXT_CHARS) },
      ],
      facts: { role: "member", teams: [], clients: [] },
    };
    const text = personContext(p);
    expect(text).toContain("- Como prefere as respostas: [M1] Responda em tabela.");
    expect(text).toContain("- Onde trabalha: [M2] Fecha o mês do 5022. (por enquanto)");
    expect(text).not.toContain("xxxx");
    expect([...personRefs(p)]).toEqual([
      ["M1", "a"],
      ["M2", "b"],
    ]);
  });

  it("anotar na conversa: confere o pedido e troca o [M#] pelo id", () => {
    const refs = new Map([["M2", "id-2"]]);
    expect(memoryNote({ op: "add", kind: "preference", text: "  Responda   em tabela. " }, refs)).toEqual({
      op: "add",
      id: null,
      kind: "preference",
      text: "Responda em tabela.",
      durability: "stable",
    });
    expect(memoryNote({ op: "replace", ref: "[m2]", kind: "context", text: "Atua no 5022.", durability: "situation" }, refs)).toMatchObject({
      op: "replace",
      id: "id-2",
      durability: "situation",
    });
    expect(memoryNote({ op: "forget", ref: "M2" }, refs)).toMatchObject({ op: "forget", id: "id-2", text: null });
    expect(memoryNote({ op: "forget", ref: "M7" }, refs)).toMatch(/não está na memória/);
    expect(memoryNote({ op: "add", kind: "humor", text: "Algo" }, refs)).toMatch(/kind e o text/);
    expect(memoryNote({ op: "apagar" }, refs)).toMatch(/add, replace ou forget/);
  });

  it("as mudanças: só os tipos conhecidos, com texto", () => {
    expect(
      parsePersonOps(
        '{"ops":[{"op":"add","kind":"preference","text":"Responda em tabela."},{"op":"add","kind":"humor","text":"x y z"},{"op":"add","kind":"context","text":"a"},{"op":"retire","id":"i1"}]}',
      ),
    ).toEqual([
      { op: "add", kind: "preference", text: "Responda em tabela." },
      { op: "retire", id: "i1" },
    ]);
    expect(() => parsePersonOps("nada")).toThrow(/JSON/);
  });

  it("no contexto da pergunta: por grupo, com os clientes e as equipes", () => {
    expect(personContext(null)).toBe("");
    expect(personContext({ items: [], facts: { role: "member", teams: [], clients: [] } })).toBe("");
    const text = personContext({
      items: [
        { kind: "preference", text: "Responda em tabela." },
        { kind: "frustration", text: "Não pare no meio." },
      ],
      facts: { role: "member", teams: ["Squad Primogênito"], clients: [{ id: "k1", name: "5022", n: 3 }] },
    });
    expect(text).toContain("- Como prefere as respostas: Responda em tabela.");
    expect(text).toContain("- Evite: Não pare no meio.");
    expect(text).toContain("- Clientes que mais consulta com você: 5022.");
    expect(text).toContain("- Equipes: Squad Primogênito.");
  });

  it("o juiz lê o jeito da pessoa", () => {
    const text = judgeMessage(
      {
        message: 1,
        company,
        conversation,
        signals: ["frustration"],
        question: "Q",
        answer: "A",
        steps: null,
        artifacts: [],
        client: null,
        sources: [],
        dossier: [],
        person: [],
        traits: [{ kind: "preference", text: "Responda em tabela." }],
      },
      null,
    );
    expect(text).toContain("O jeito desta pessoa (a base de comportamento dela):\n- preference: Responda em tabela.");
  });
});

function database(routes: Record<string, unknown | ((b: any) => unknown)>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    const value = key ? routes[key] : [];
    return new Response(JSON.stringify(typeof value === "function" ? (value as (b: any) => unknown)(body) : value), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("base de comportamento · worker", () => {
  it("depois da autoavaliação, lê uma pessoa por vez e grava as mudanças com o gasto", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_learning_claim": null,
      "rpc/mavi_learning_claim": null,
      "rpc/mavi_judge_claim": [],
      "rpc/mavi_person_claim": () => (claims++ === 0 ? claim : null),
      "rpc/ai_worker_route": null,
      "rpc/mavi_person_store": 1,
    });
    const requests: AgentRequest[] = [];
    const llm: LlmAdapter = async (req) => {
      requests.push(req);
      const meter = newMeter("claude-opus-5-5");
      meter.cost = 0.01;
      return { text: '{"ops":[{"op":"add","kind":"preference","text":"Responda listas de clientes em tabela."}]}', meter, rounds: 0 };
    };
    const deps = { fetch: fetchImpl, llm, embed: vi.fn() };
    const res = await handleLearningWorker(`Bearer ${env.workerSecret}`, lenv, deps, {
      env,
      deps,
      judge: { env, deps, budgetMs: 60_000 },
    });
    expect((res.body as any).people).toEqual({ people: 1, changes: 1, failed: 0 });
    expect(requests[0].instructions).toContain("Nunca julgue a pessoa");
    const store = calls.find((c) => c.url.endsWith("/rpc/mavi_person_store"))!;
    expect(store.body).toMatchObject({
      p_company: company,
      p_user: me,
      p_ops: [{ op: "add", kind: "preference", text: "Responda listas de clientes em tabela." }],
    });
    expect(store.body.p_usage).toMatchObject({ cost: 0.01 });
    const route = calls.find((c) => c.url.endsWith("/rpc/ai_worker_route"))!;
    expect(route.body.p_feature).toBe("mavi_learning");
  });
});

describe("base de comportamento · na pergunta", () => {
  it("o que a MAVI sabe de quem pergunta entra no contexto", async () => {
    const { fetchImpl } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      "rpc/ai_save_turn": conversation,
      "rpc/mavi_person_context": {
        items: [{ kind: "preference", text: "Responda listas de clientes em tabela." }],
        facts: { role: "member", teams: [], clients: [] },
      },
    });
    let request: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      request = r;
      return { text: "Pronto.", meter: newMeter("claude-opus-5-5"), rounds: 0 };
    };
    await streamAi(
      { action: "ai-ask", company, question: "Quais clientes estão frios?", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      () => {},
      { onClose: () => {} },
    );
    expect(request!.context).toContain("Sobre quem pergunta");
    expect(request!.context).toContain("- Como prefere as respostas: Responda listas de clientes em tabela.");
  });

  it("a MAVI anota o que a pessoa disse (cartão com Desfazer) e a resposta guarda a memória que leu", async () => {
    const item = "00000000-0000-4000-8000-0000000000a1";
    const noted = "00000000-0000-4000-8000-0000000000a9";
    const { fetchImpl, calls } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      "rpc/ai_save_turn": conversation,
      "rpc/ai_usage_close_turn": 321,
      "rpc/mavi_person_context": {
        items: [{ id: item, kind: "preference", text: "Responda em tópicos." }],
        facts: { role: "member", teams: [], clients: [] },
      },
      "rpc/mavi_person_note": (b: any) => ({
        op: b.p_op,
        id: noted,
        kind: b.p_kind,
        text: b.p_text,
        durability: b.p_durability,
        previous: "Responda em tópicos.",
        previous_id: item,
      }),
      "rpc/mavi_person_used": null,
    });
    let round = 0;
    let tools: string[] = [];
    let instructions = "";
    const llm: LlmAdapter = async (r) => {
      tools = r.tools.map((t) => t.name);
      instructions = r.instructions;
      const out = await r.execute("remember_about_me", { op: "replace", ref: "M1", kind: "preference", text: "Responda em tabela." });
      expect(out).toContain("Anotado na memória dela (no lugar de “Responda em tópicos.”)");
      round++;
      return { text: "Anotado: daqui pra frente, em tabela.", meter: newMeter("claude-opus-5-5"), rounds: 1 };
    };
    const events: any[] = [];
    await streamAi(
      { action: "ai-ask", company, question: "Daqui pra frente, sempre em tabela, não em tópicos", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    expect(round).toBe(1);
    expect(tools).toContain("remember_about_me");
    expect(instructions).toContain("Memória de quem pergunta");
    const note = calls.find((c) => c.url.endsWith("/rpc/mavi_person_note"))!;
    expect(note.body).toMatchObject({
      p_company: company,
      p_op: "replace",
      p_id: item,
      p_kind: "preference",
      p_text: "Responda em tabela.",
      p_durability: "stable",
      p_conversation: conversation,
      p_said: "Daqui pra frente, sempre em tabela, não em tópicos",
    });
    const card = events.find((e) => e.type === "artifact")?.artifact;
    expect(card).toMatchObject({ type: "memory", op: "replace", item: noted, previous_id: item, ref: "B1" });
    const used = calls.find((c) => c.url.endsWith("/rpc/mavi_person_used"))!;
    expect(used.body).toEqual({ p_message: 321, p_ids: [item] });
    expect(events.find((e) => e.type === "done")?.memory).toEqual([item]);
  });

  it("o banco recusa o cartão: a pergunta e a resposta ficam salvas sem ele", async () => {
    const { fetchImpl, calls } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      // Antes da migração 20270613180000, o tipo "memory" derrubava a vez inteira.
      "rpc/ai_save_turn": (b: any) => {
        if (b.p_artifacts) throw Error("Anexos da resposta inválidos.");
        return conversation;
      },
      "rpc/ai_usage_close_turn": 321,
      "rpc/mavi_person_context": { items: [], facts: { role: "member", teams: [], clients: [] } },
      "rpc/mavi_person_note": (b: any) => ({
        op: b.p_op,
        id: "00000000-0000-4000-8000-0000000000a9",
        kind: b.p_kind,
        text: b.p_text,
        durability: b.p_durability,
      }),
    });
    const llm: LlmAdapter = async (r) => {
      await r.execute("remember_about_me", { op: "add", kind: "preference", text: "Responda em tabela." });
      return { text: "Anotado. Tarefa criada.", meter: newMeter("claude-opus-5-5"), rounds: 1 };
    };
    const events: any[] = [];
    await streamAi(
      { action: "ai-ask", company, question: "Crie a tarefa e responda sempre em tabela", surface: "page" },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    const saves = calls.filter((c) => c.url.endsWith("/rpc/ai_save_turn"));
    expect(saves).toHaveLength(2);
    expect(saves[0].body.p_artifacts).toHaveLength(1);
    expect(saves[1].body).toMatchObject({
      p_conversation: conversation,
      p_question: "Crie a tarefa e responda sempre em tabela",
      p_answer: "Anotado. Tarefa criada.",
    });
    expect(saves[1].body.p_artifacts).toBeUndefined();
    const warnings = events.filter((e) => e.type === "warning").map((e) => e.text);
    expect(warnings).toEqual(["Os cartões desta resposta não foram salvos; o texto ficou na conversa."]);
    expect(events.find((e) => e.type === "done")?.conversation).toBe(conversation);
  });
});
