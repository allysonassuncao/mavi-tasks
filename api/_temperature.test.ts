import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { aiEnv, type AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { seal } from "./_google";
import { runTool, temperatureLine, type ToolContext } from "./_ai-tools";
import { newMeter } from "./_social-leads";
import {
  askJev,
  buildQuestions,
  decisionsUrl,
  examplesFor,
  handleTemperatureWorker,
  lessonsMessage,
  parseAnswers,
  parseLessonOps,
  scorePercent,
  shrinkState,
  summaryMessage,
  type Example,
  type LessonsClaim,
  type Questions,
} from "./_temperature";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const signalA = "00000000-0000-4000-8000-0000000000a1";
const signalB = "00000000-0000-4000-8000-0000000000b1";
const provider = "00000000-0000-4000-8000-000000000800";
const providerKey = crypto.randomBytes(32);
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-haiku-4-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
};
const embed = vi.fn();

const questions: Questions = {
  indicators: [
    {
      key: "satisfacao",
      kind: "score",
      name: "Satisfação com resultados",
      description: "Como o cliente avalia os resultados.",
      levels: ["Muito insatisfeito", "Insatisfeito", "Neutro", "Satisfeito", "Muito satisfeito"],
      sources: ["meeting", "whatsapp"],
    },
    {
      key: "engajamento",
      kind: "score",
      name: "Engajamento",
      description: "O quanto o cliente participa.",
      levels: ["Ausente", "Baixo", "Alto"],
      sources: ["whatsapp"],
    },
    {
      key: "cancelamento",
      kind: "flag",
      name: "Fala em cancelar",
      description: "O cliente fala em cancelar?",
      levels: [],
      sources: ["meeting", "whatsapp"],
    },
  ],
  reasons: [
    { key: "resultados", label: "Resultados" },
    { key: "prazos", label: "Prazos" },
    { key: "rotina", label: "Rotina" },
  ],
  reason_question: "Qual assunto mais mexe com o cliente?",
};

const jevConfig = {
  kind: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-or",
  model: "~typesafe/jev-latest",
  price: { id: "~typesafe/jev-latest", label: "Jev", input: 0.042, output: 0 },
};

describe("perguntas ao Jev", () => {
  it("usa a API de decisões ao lado da de chat", () => {
    expect(decisionsUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
    expect(decisionsUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
  });

  it("cada indicador vira escala + evidência; sinal vira sim/não; assuntos, uma escolha", () => {
    const q = buildQuestions(questions, "meeting");
    expect(Object.keys(q)).toEqual([
      "i_satisfacao",
      "e_satisfacao",
      "f_cancelamento",
      "motivo",
    ]);
    expect(q.i_satisfacao).toMatchObject({
      type: "score",
      criteria: questions.indicators[0].levels,
    });
    expect(q.i_satisfacao.instructions).toMatch(/Avalie o cliente/);
    expect(q.e_satisfacao.type).toBe("noul");
    expect(q.motivo).toMatchObject({
      type: "choice",
      criteria: { resultados: "Resultados", prazos: "Prazos", rotina: "Rotina" },
    });
    // Engajamento só no WhatsApp.
    expect(Object.keys(buildQuestions(questions, "whatsapp"))).toContain(
      "i_engajamento",
    );
  });

  it("converte a posição na escala para 0–100 (índices a partir de 0 ou de 1)", () => {
    expect(scorePercent({ score: 2 }, 5)).toBe(50);
    expect(scorePercent({ score: 4, probabilities: { "0": 0, "4": 1 } }, 5)).toBe(100);
    expect(
      scorePercent({ score: 3, legend: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" } }, 5),
    ).toBe(50);
    expect(scorePercent({ probabilities: { "0": 0.5, "2": 0.5 } }, 3)).toBe(50);
    expect(scorePercent({}, 5)).toBeNull();
    expect(scorePercent({ score: 9 }, 5)).toBe(100);
  });

  it("guarda nota, confiança e evidência; sinal; assunto só entre os conhecidos", () => {
    const ev = parseAnswers(questions, {
      answers: {
        i_satisfacao: { type: "score", score: 1, confidence: 0.83 },
        e_satisfacao: { type: "noul", noul: 0.9 },
        f_cancelamento: { type: "noul", noul: 0.12 },
        motivo: {
          type: "choice",
          choice: "resultados",
          probabilities: { resultados: 0.7, prazos: 0.2, outro: 0.1 },
        },
      },
    });
    expect(ev.answers).toEqual({ satisfacao: { v: 25, c: 0.83, e: 0.9 } });
    expect(ev.flags).toEqual({ cancelamento: 0.12 });
    expect(ev.reason).toEqual({ key: "resultados", p: { resultados: 0.7, prazos: 0.2 } });
    expect(
      parseAnswers(questions, { answers: { motivo: { choice: "inventado" } } }).reason,
    ).toBeNull();
  });

  it("chama o Jev com a chave e, se o material não couber, tenta com menos texto", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url, auth: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
      if (bodies.length === 1)
        return new Response(JSON.stringify({ error: { message: "context length exceeded" } }), { status: 400 });
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13",
          answers: { i_satisfacao: { type: "score", score: 3 } },
          usage: { input_tokens: 10000 },
        }),
      );
    }) as unknown as typeof fetch;
    const long = "x".repeat(10000);
    const res = await askJev(jevConfig, { cliente: "4282", conversa: long }, buildQuestions(questions, "meeting"), fetchImpl);
    expect(bodies[0].url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(bodies[0].auth).toBe("Bearer sk-or");
    expect(bodies[0].body.model).toBe("~typesafe/jev-latest");
    expect(bodies[0].body.state.conversa).toHaveLength(10000);
    expect(bodies[1].body.state.conversa.length).toBeLessThan(6000);
    expect(bodies[1].body.state.cliente).toBe("4282");
    // Sem usage.cost: pelo preço cadastrado.
    expect(res.cost).toBeCloseTo((10000 * 0.042) / 1e6, 10);
    expect(res.tokens).toBe(10000);
  });

  it("outra recusa do Jev não encurta o texto e guarda a mensagem dele", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "questions.i_x.criteria: invalid" } }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(askJev(jevConfig, { conversa: "x" }, {}, fetchImpl)).rejects.toThrow(
      /O Jev respondeu com erro \(400\): questions\.i_x\.criteria: invalid/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("chave recusada vira uma mensagem clara", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(askJev(jevConfig, {}, {}, fetchImpl)).rejects.toThrow(/API Key do provedor "OpenRouter"/);
  });

  it("encurta só os textos longos e fica com o fim", () => {
    const s = shrinkState({ a: "curto", b: `${"a".repeat(3000)}FIM` }, 0.5);
    expect(s.a).toBe("curto");
    expect(String(s.b)).toMatch(/^\[… trecho omitido …\]\n/);
    expect(String(s.b).endsWith("FIM")).toBe(true);
  });
});

function database(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, auth: new Headers(init?.headers).get("Authorization") });
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

describe("worker do termômetro", () => {
  it("recusa sem o segredo", async () => {
    const res = await handleTemperatureWorker("Bearer errado", env, {
      fetch: vi.fn() as any,
      llm: vi.fn(),
      embed,
    });
    expect(res.status).toBe(401);
  });

  it("aceita o AI_WORKER_SECRET da Vercel com espaços nas pontas", async () => {
    const fromVercel = aiEnv(
      { supabaseUrl: env.supabaseUrl, supabaseKey: env.supabaseKey },
      { AI_WORKER_SECRET: "segredo-do-worker\n" },
    );
    expect(fromVercel.workerSecret).toBe("segredo-do-worker");
    const res = await handleTemperatureWorker(
      "Bearer segredo-do-worker",
      { ...fromVercel, workerBudgetMs: 0 },
      { fetch: vi.fn() as any, llm: vi.fn(), embed },
    );
    expect(res.status).toBe(200);
  });

  it("lê com o Jev, grava, recalcula e escreve o texto; falha volta para a fila", async () => {
    let claims = 0;
    let refreshes = 0;
    let summaries = 0;
    const signalC = "00000000-0000-4000-8000-0000000000c9";
    // A reserva é leve; o material vem uma leitura por chamada.
    const signal = (id: string) => ({
      id,
      company_id: company,
      client_id: client,
      source_type: "whatsapp",
      version: 3,
    });
    const material: Record<string, unknown> = {
      [signalA]: {
        state: { cliente: "4282", conversa: "tudo certo" },
        excerpt: "Não gostei",
        message_id: "00000000-0000-4000-8000-0000000000c1",
        client_lines: 2,
      },
      [signalB]: {
        state: { cliente: "4282", conversa: "QUEBRA" },
        excerpt: "",
        message_id: null,
        client_lines: 1,
      },
      // Sem fala do cliente: o banco pula e devolve nulo.
      [signalC]: null,
    };
    const { fetchImpl, calls } = database({
      "rpc/ai_temperature_claim": () =>
        claims++ === 0 ? [signal(signalA), signal(signalB), signal(signalC)] : [],
      "rpc/ai_temperature_material": (b: any) => material[b.p_id],
      "rpc/ai_temperature_config": {
        version: 3,
        questions,
        route: {
          provider_id: provider,
          provider: "OpenRouter",
          kind: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          key_cipher: seal(providerKey, "sk-or"),
          model: "~typesafe/jev-latest",
          price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
        },
      },
      "alpha/decisions": (b: any) =>
        b.state.conversa === "QUEBRA"
          ? new Response("erro", { status: 500 })
          : {
              model: "typesafe/jev-1.13",
              answers: {
                i_satisfacao: { type: "score", score: 1, confidence: 0.9 },
                e_satisfacao: { type: "noul", noul: 0.8 },
                i_engajamento: { type: "score", score: 2, confidence: 0.6 },
                e_engajamento: { type: "noul", noul: 0.4 },
                f_cancelamento: { type: "noul", noul: 0.05 },
                motivo: { type: "choice", choice: "resultados", probabilities: { resultados: 0.9, rotina: 0.1 } },
              },
              usage: { input_tokens: 3000, cost: 0.000126 },
            },
      "rpc/ai_temperature_store": 1,
      "rpc/ai_temperature_fail": null,
      "rpc/ai_temperature_refresh": () => (refreshes++ === 0 ? 1 : 0),
      "rpc/ai_temperature_summary_claim": () =>
        summaries++ === 0
          ? [
              {
                client_id: client,
                company_id: company,
                client_name: "4282",
                products: "Tráfego",
                names: { satisfacao: "Satisfação com resultados" },
                band_name: "Frio",
                current: {
                  score: 38,
                  score_d7: -12,
                  score_d30: null,
                  indicators: [{ name: "Satisfação com resultados", value: 25, d30: null }],
                  flags: [],
                  reasons: [{ label: "Resultados", share: 90 }],
                },
                previous: null,
                evidence: [
                  {
                    type: "whatsapp",
                    title: "Whatsapp · 4282",
                    date: "2026-09-20T12:00:00Z",
                    excerpt: "Não gostei",
                    answers: { satisfacao: { v: 25 } },
                    flags: {},
                    reason: "resultados",
                  },
                ],
              },
            ]
          : [],
      "rpc/ai_worker_route": null,
      "rpc/ai_temperature_summary_store": null,
    });
    const prompts: string[] = [];
    const llm: LlmAdapter = async (req) => {
      prompts.push(req.messages[0].content);
      const meter = newMeter("claude-haiku-4-5");
      meter.cost = 0.001;
      return {
        text: "O cliente esfriou por causa dos resultados no WhatsApp em 20/09. Vale uma conversa com números.",
        meter,
        rounds: 0,
      };
    };
    const res = await handleTemperatureWorker(`Bearer ${env.workerSecret}`, env, {
      fetch: fetchImpl,
      llm,
      embed,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signals: 1, failed: 1, skipped: 1, removed: 0, clients: 1, summaries: 1, lessons: 0 });
    expect(
      calls.filter((c) => c.url.includes("rpc/ai_temperature_material")).map((c) => c.body.p_id).sort(),
    ).toEqual([signalA, signalB, signalC].sort());
    expect(calls.find((c) => c.url.includes("rpc/ai_temperature_refresh"))!.body.p_limit).toBe(2);
    expect(calls.filter((c) => c.url.includes("alpha/decisions"))).toHaveLength(2);

    const jev = calls.find((c) => c.url.includes("alpha/decisions"))!;
    expect(jev.auth).toBe("Bearer sk-or");
    expect(Object.keys(jev.body.questions)).toContain("i_engajamento");

    const store = calls.find((c) => c.url.includes("rpc/ai_temperature_store"))!;
    expect(store.auth).toBe(`Bearer ${env.supabaseKey}`);
    expect(store.body.p_secret).toBe(env.workerSecret);
    expect(store.body.p_results).toHaveLength(1);
    expect(store.body.p_results[0]).toMatchObject({
      id: signalA,
      version: 3,
      answers: {
        satisfacao: { v: 25, c: 0.9, e: 0.8 },
        engajamento: { v: 100, c: 0.6, e: 0.4 },
      },
      flags: { cancelamento: 0.05 },
      reason: { key: "resultados" },
      cost: 0.000126,
      input: 3000,
      model: "typesafe/jev-1.13",
      provider_id: provider,
      message_id: "00000000-0000-4000-8000-0000000000c1",
    });
    const fail = calls.find((c) => c.url.includes("rpc/ai_temperature_fail"))!;
    expect(fail.body.p_id).toBe(signalB);
    expect(fail.body.p_error).toMatch(/erro \(500\)/);

    expect(prompts[0]).toMatch(/Temperatura hoje: 38\/100 · faixa Frio · -12 em 7 dias/);
    expect(prompts[0]).toMatch(
      /\[1\] WhatsApp "Whatsapp · 4282" · 20\/09\/2026 · notas: Satisfação com resultados 25 · assunto: resultados/,
    );
    const text = calls.find((c) => c.url.includes("rpc/ai_temperature_summary_store"))!;
    expect(text.body.p_client).toBe(client);
    expect(text.body.p_text).toMatch(/^O cliente esfriou/);
    expect(text.body.p_usage).toMatchObject({ model: "claude-haiku-4-5", cost: 0.001 });
  });

  it("sem a AI_PROVIDER_KEY a leitura não queima tentativas", async () => {
    const { fetchImpl, calls } = database({
      "rpc/ai_temperature_claim": [
        {
          id: signalA,
          company_id: company,
          client_id: client,
          source_type: "meeting",
          version: 1,
        },
      ],
      "rpc/ai_temperature_config": {
        version: 1,
        questions,
        route: { provider_id: provider, provider: "OpenRouter", kind: "openrouter", base_url: null, key_cipher: "v1:x", model: "~typesafe/jev-latest", price: null },
      },
    });
    const res = await handleTemperatureWorker(`Bearer ${env.workerSecret}`, { ...env, providerKey: null }, {
      fetch: fetchImpl,
      llm: vi.fn(),
      embed,
    });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/AI_PROVIDER_KEY/);
    expect(calls.some((c) => c.url.includes("ai_temperature_fail"))).toBe(false);
  });

  it("o texto da MAVI traz sinais, assuntos e a explicação anterior", () => {
    const msg = summaryMessage({
      client_id: client,
      company_id: company,
      client_name: "4282",
      products: "",
      band_name: "Gelado",
      current: {
        score: 12.4,
        score_d7: null,
        score_d30: -40,
        indicators: [{ name: "Risco de cancelamento", value: 5, d30: -60 }],
        flags: [{ name: "Fala em cancelar", at: "2026-09-25T15:00:00Z" }],
        reasons: [],
      },
      previous: { text: "Estava tudo bem.", at: "2026-09-01T10:00:00Z", score: 72, band_name: "Quente" },
      evidence: [],
    });
    expect(msg).toMatch(/Temperatura hoje: 12\/100 · faixa Gelado · -40 em 30 dias/);
    expect(msg).toMatch(/Risco de cancelamento 5 \(-60 em 30 dias\)/);
    expect(msg).toMatch(/Sinais de alerta: Fala em cancelar \(25\/09\/2026\)/);
    expect(msg).toMatch(/Explicação anterior \(01\/09\/2026, nota 72, faixa Quente\): Estava tudo bem\./);
  });
});

describe("correções do time e regras da MAVI", () => {
  const other = "00000000-0000-4000-8000-000000000003";
  const example = (over: Partial<Example>): Example => ({
    client_id: client,
    client: "4282",
    signal_id: null,
    kind: "flag",
    key: "cancelamento",
    before: true,
    after: false,
    note: "Era brincadeira sobre férias.",
    type: "meeting",
    day: "2026-09-12",
    excerpt: "Vou sumir em dezembro, hein!",
    ...over,
  });

  it("as regras vão nas perguntas; com regras de leitura, o Jev confere se a leitura conta", () => {
    const plain = buildQuestions(questions, "meeting");
    expect(plain.relevante).toBeUndefined();
    const q = buildQuestions(questions, "meeting", {
      cancelamento: ["Férias não é cancelar."],
      satisfacao: ["Pedido de relatório não é insatisfação."],
      motivo: ["Verba nova é Financeiro."],
      leitura: ["Reunião só com o time não conta."],
    });
    expect(q.f_cancelamento.instructions).toMatch(/Regras que o time da agência ensinou \(siga\): \(1\) Férias não é cancelar\.$/);
    expect(q.i_satisfacao.instructions).toMatch(/Pedido de relatório/);
    expect(q.e_satisfacao.instructions).toMatch(/Pedido de relatório/);
    expect(q.motivo.instructions).toMatch(/Verba nova é Financeiro/);
    expect(q.relevante).toMatchObject({ type: "noul" });
    expect(q.relevante.instructions).toMatch(/Reunião só com o time não conta/);
    const parsed = parseAnswers(questions, { answers: { relevante: { noul: 0.1 } } });
    expect(parsed.relevant).toBe(0.1);
    expect(parseAnswers(questions, { answers: {} }).relevant).toBeUndefined();
  });

  it("os exemplos: do mesmo cliente primeiro, até 8, sem repetir", () => {
    expect(examplesFor(null, client, questions)).toBeNull();
    expect(examplesFor({ lessons: {}, examples: [] }, client, questions)).toBeNull();
    const examples = [
      ...Array.from({ length: 6 }, (_, i) =>
        example({ client_id: other, client: "9001", day: `2026-09-0${i + 1}`, note: `outro ${i}` }),
      ),
      example({ kind: "reason", key: null, before: "resultados", after: "prazos", note: "" }),
      example({ kind: "score", key: "satisfacao", before: { v: 20 }, after: { v: 75, e: 1 } }),
      example({ kind: "score", key: "satisfacao", before: { v: 20 }, after: { v: 20, e: 0 } }),
      example({ kind: "remove", key: null, before: null, after: null, note: "Reunião interna." }),
      example({ kind: "remove", key: null, before: null, after: null, note: "Reunião interna." }),
    ];
    const text = examplesFor({ lessons: {}, examples }, client, questions)!;
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(
      '- [4282 · reunião de 12/09] o assunto era "Prazos", não "Resultados". Trecho: "Vou sumir em dezembro, hein!"',
    );
    expect(lines[1]).toMatch(/"Satisfação com resultados" \(0 a 100\) era 75, não 20\. Motivo: Era brincadeira/);
    expect(lines[2]).toMatch(/"Satisfação com resultados": o material não fala disso/);
    expect(lines[3]).toMatch(/o time retirou a leitura: não conta para o termômetro\. Motivo: Reunião interna\./);
    expect(lines[4]).toMatch(/^- \[9001 · reunião de 01\/09\] o time tirou o sinal "Fala em cancelar"/);
    expect(text).toMatch(/^Correções que o time da agência já fez/);
  });

  it("as mudanças da MAVI: só chaves e regras conhecidas, com as correções citadas", () => {
    const claim: LessonsClaim = {
      company,
      indicators: questions.indicators.map(({ key, kind, name, description }) => ({ key, kind, name, description })),
      reasons: questions.reasons!,
      lessons: [{ id: "l1", key: "cancelamento", text: "Férias não é cancelar.", status: "active", origin: "person", locked: true }],
      feedback: [
        { id: 7, kind: "flag", key: "cancelamento", before: true, after: false, note: "Brincadeira.", type: "meeting", day: "2026-09-12", title: "Reunião", excerpt: "Vou sumir", client: "4282" },
        { id: 9, kind: "restore", key: null, before: { auto: true }, after: null, note: "", type: "whatsapp", day: "2026-09-13", title: "Grupo", excerpt: "", client: "4282" },
      ],
    };
    const msg = lessonsMessage(claim);
    expect(msg).toMatch(/- id l1 · cancelamento · travada por pessoa: Férias não é cancelar\./);
    expect(msg).toMatch(/\[F1\] Reunião de 2026-09-12 · chave cancelamento: o time tirou o sinal "Fala em cancelar" \(não aconteceu\)\.\n  motivo do time: Brincadeira\./);
    expect(msg).toMatch(/\[F2\] WhatsApp de 2026-09-13 · chave leitura: o time devolveu uma leitura que a MAVI tinha retirado sozinha/);
    const ops = parseLessonOps(
      `Aqui: {"ops":[{"op":"add","key":"cancelamento","text":"Brincadeira sobre sumir não é cancelar.","feedback":["F1","F9"]},
        {"op":"add","key":"desconhecida","text":"Não entra."},{"op":"update","id":"l1","text":"Ok mudado.","feedback":["F2"]},
        {"op":"retire","id":"zzz"},{"op":"add","key":"leitura","text":"oi"}]}`,
      claim,
    );
    expect(ops).toEqual([
      { op: "add", key: "cancelamento", text: "Brincadeira sobre sumir não é cancelar.", feedback: [7] },
      { op: "update", id: "l1", text: "Ok mudado.", feedback: [9] },
    ]);
    expect(() => parseLessonOps("sem json", claim)).toThrow(/JSON/);
  });

  it("o worker manda regras e exemplos ao Jev, retira o que não conta e escreve as regras", async () => {
    let claims = 0;
    let lessonClaims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_temperature_claim": () =>
        claims++ === 0
          ? [signalA, signalB].map((id) => ({ id, company_id: company, client_id: client, source_type: "meeting", version: 3 }))
          : [],
      "rpc/ai_temperature_material": (b: any) => ({
        state: { cliente: "4282", transcricao: b.p_id === signalA ? "boa" : "interna" },
        excerpt: "",
        message_id: null,
        client_lines: 2,
      }),
      "rpc/ai_temperature_config": {
        version: 3,
        questions,
        route: {
          provider_id: provider,
          provider: "OpenRouter",
          kind: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          key_cipher: seal(providerKey, "sk-or"),
          model: "~typesafe/jev-latest",
          price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
        },
      },
      "rpc/ai_temperature_learning": {
        lessons: { leitura: ["Reunião só com o time não conta."], cancelamento: ["Férias não é cancelar."] },
        examples: [example({})],
      },
      "alpha/decisions": (b: any) => ({
        answers: {
          relevante: { noul: b.state.transcricao === "interna" ? 0.05 : 0.9 },
          i_satisfacao: { score: 3, confidence: 0.9 },
          e_satisfacao: { noul: 0.9 },
        },
        usage: { input_tokens: 100, cost: 0.00001 },
      }),
      "rpc/ai_temperature_store": 2,
      "rpc/ai_temperature_irrelevant": 1,
      "rpc/ai_temperature_refresh": 0,
      "rpc/ai_temperature_summary_claim": [],
      "rpc/ai_temperature_lessons_claim": () =>
        lessonClaims++ === 0
          ? {
              company,
              indicators: [{ key: "cancelamento", kind: "flag", name: "Fala em cancelar", description: "Cancelar?" }],
              reasons: [{ key: "resultados", label: "Resultados" }],
              lessons: [],
              feedback: [
                { id: 3, kind: "flag", key: "cancelamento", before: true, after: false, note: "Brincadeira.", type: "meeting", day: "2026-09-12", title: "Reunião", excerpt: "Vou sumir", client: "4282" },
              ],
            }
          : null,
      "rpc/ai_worker_route": null,
      "rpc/ai_temperature_lessons_store": 1,
    });
    const llm: LlmAdapter = async (req) => {
      expect(req.instructions).toMatch(/regras curtas/);
      expect(req.messages[0].content).toMatch(/\[F1\]/);
      const meter = newMeter("claude-haiku-4-5");
      return {
        text: '{"ops":[{"op":"add","key":"cancelamento","text":"Brincadeira sobre sumir não é cancelar.","feedback":["F1"]}]}',
        meter,
        rounds: 0,
      };
    };
    const res = await handleTemperatureWorker(`Bearer ${env.workerSecret}`, env, { fetch: fetchImpl, llm, embed });
    expect(res.body).toMatchObject({ signals: 2, removed: 1, lessons: 1 });
    const jev = calls.filter((c) => c.url.includes("alpha/decisions"));
    expect(jev[0].body.state.correcoes_do_time).toMatch(/o time tirou o sinal "Fala em cancelar"/);
    expect(jev[0].body.questions.f_cancelamento.instructions).toMatch(/Férias não é cancelar/);
    expect(jev[0].body.questions.relevante).toBeTruthy();
    const store = calls.find((c) => c.url.includes("rpc/ai_temperature_store"))!;
    expect(store.body.p_results.every((r: any) => !("relevant" in r))).toBe(true);
    const irrelevant = calls.find((c) => c.url.includes("rpc/ai_temperature_irrelevant"))!;
    expect(irrelevant.body.p_ids).toEqual([signalB]);
    const lessons = calls.find((c) => c.url.includes("rpc/ai_temperature_lessons_store"))!;
    expect(lessons.body.p_ops).toEqual([
      { op: "add", key: "cancelamento", text: "Brincadeira sobre sumir não é cancelar.", feedback: [3] },
    ]);
    expect(lessons.body.p_learned).toEqual([3]);
  });
});

describe("o termômetro nas conversas com a MAVI", () => {
  const temperature = {
    settings: {
      window_days: 60,
      bands: [
        { name: "Gelado", min: 0, alert: true },
        { name: "Frio", min: 30, alert: true },
        { name: "Quente", min: 70, alert: false },
      ],
    },
    indicators: [
      { key: "satisfacao", name: "Satisfação com resultados", kind: "score" },
      { key: "cancelamento", name: "Fala em cancelar", kind: "flag" },
    ],
    current: {
      score: 38.4,
      band: 1,
      score_d7: -12.2,
      score_d30: null,
      signals: 5,
      indicators: [{ key: "satisfacao", name: "Satisfação com resultados", value: 25, d30: -30 }],
      flags: [{ key: "cancelamento", name: "Fala em cancelar", alert: true, at: "2026-09-25T15:00:00Z" }],
      reasons: [{ key: "resultados", label: "Resultados", share: 70 }],
    },
    summary: { text: "Esfriou com os leads.", at: "2026-09-26T10:00:00Z" },
    refreshed_at: "2026-09-27T09:00:00Z",
    signals: [
      {
        type: "meeting",
        source_id: "00000000-0000-4000-8000-0000000000e1",
        group_id: null,
        message_id: null,
        title: "Alinhamento",
        date: "2026-09-25T15:00:00Z",
        status: "done",
        answers: { satisfacao: { v: 10, e: 0.9 } },
        flags: { cancelamento: 0.92 },
        reason: "resultados",
        excerpt: "Quer cancelar.",
      },
      {
        type: "whatsapp",
        source_id: "00000000-0000-4000-8000-0000000000e2",
        group_id: "00000000-0000-4000-8000-0000000000e3",
        message_id: "00000000-0000-4000-8000-0000000000e4",
        title: "Whatsapp · 4282",
        date: "2026-09-26T12:00:00Z",
        status: "done",
        answers: { satisfacao: { v: 40, e: 0.1 } },
        flags: {},
        reason: null,
        excerpt: "",
      },
    ],
    pending: 0,
    jev: true,
  };
  const ctx = (fetchImpl: typeof fetch, scope = {}): ToolContext => ({
    supabaseUrl: env.supabaseUrl,
    supabaseKey: env.supabaseKey,
    fetch: fetchImpl,
    auth: "Bearer pessoa",
    company,
    scope,
    embed,
    members: new Map(),
    clients: new Map([[client, "4282"]]),
    today: "2026-09-27",
    usage: { embeddingTokens: 0, embeddingModel: "" },
    sources: [],
    chunks: new Map(),
  });

  it("com o cliente: nota, faixa, indicadores, sinais, explicação e leituras citadas", async () => {
    const { fetchImpl, calls } = database({ "rpc/client_temperature": temperature });
    const c = ctx(fetchImpl, { client });
    const out = await runTool(c, "client_temperature", {});
    expect(out).toMatch(/^Termômetro do cliente 4282: 38\/100 · Frio · -12 em 7 dias · 5 leituras nos últimos 60 dias/);
    expect(out).toMatch(/Satisfação com resultados 25 · -30 em 30 dias/);
    expect(out).toMatch(/Sinais de alerta recentes: Fala em cancelar \(25\/09\/2026\)/);
    expect(out).toMatch(/Explicação da MAVI \(26\/09\/2026\): Esfriou com os leads\./);
    expect(out).toMatch(/\[S1\] Reunião "Alinhamento" · 25\/09\/2026 · Satisfação com resultados 10 · sinais: Fala em cancelar/);
    // Nota sem evidência não aparece; a citação do WhatsApp abre a mensagem.
    expect(out).toMatch(/\[S2\] WhatsApp "Whatsapp · 4282" · 26\/09\/2026$/m);
    expect(c.sources.map((x) => [x.type, x.id, x.group])).toEqual([
      ["meeting", "00000000-0000-4000-8000-0000000000e1", undefined],
      ["whatsapp", "00000000-0000-4000-8000-0000000000e4", "00000000-0000-4000-8000-0000000000e3"],
    ]);
    const rpcCall = calls.find((x) => x.url.includes("rpc/client_temperature"))!;
    expect(rpcCall.auth).toBe("Bearer pessoa");
    expect(rpcCall.body).toMatchObject({ p_client: client, p_days: 0, p_signals: 12 });
  });

  it("sem cliente: a carteira do mais frio ao mais quente", async () => {
    const { fetchImpl } = database({
      "rpc/clients_temperature": {
        settings: temperature.settings,
        jev: true,
        clients: [
          { client_id: client, name: "4282", score: 12, band: 0, d7: -5, d30: null, flags: [{ name: "Fala em cancelar", alert: true }], reasons: [{ label: "Prazos", share: 60 }] },
          { client_id: "x", name: "9001", score: null, band: null, d7: null, d30: null, flags: [], reasons: [] },
        ],
      },
    });
    const out = await runTool(ctx(fetchImpl), "client_temperature", {});
    expect(out).toMatch(/1 clientes com temperatura/);
    expect(out).toMatch(/- Cliente 4282 \(id [0-9a-f-]+\): 12\/100 · Gelado · -5 em 7 dias · sinais: Fala em cancelar · assunto: Prazos/);
    expect(out).not.toMatch(/9001/);
    expect(out).toMatch(/Faixas de alerta: Gelado, Frio/);
  });

  it("sem o Jev, diz que o termômetro não está ligado", async () => {
    const { fetchImpl } = database({
      "rpc/clients_temperature": { settings: null, jev: false, clients: [] },
    });
    expect(await runTool(ctx(fetchImpl), "client_temperature", {})).toMatch(/não está ligado/);
  });

  it("a linha do contexto só aparece com nota", () => {
    expect(temperatureLine(temperature as any)).toMatch(
      /^Termômetro do cliente hoje: 38\/100 \(Frio\) · -12 em 7 dias · sinais de alerta: Fala em cancelar · explicação da MAVI: Esfriou/,
    );
    expect(temperatureLine({ ...temperature, current: null } as any)).toBe("");
    expect(temperatureLine([] as any)).toBe("");
  });
});
