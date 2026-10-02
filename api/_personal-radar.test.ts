import { describe, expect, it, vi } from "vitest";
import type { AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import crypto from "node:crypto";
import { seal } from "./_google";
import {
  applyCheck,
  checkQuestions,
  learningMessage,
  lessonQuestions,
  parseLearningOps,
  type LearningClaim,
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
const providerKey = crypto.randomBytes(32);
const jevRoute = {
  provider_id: "00000000-0000-4000-8000-000000000800",
  provider: "OpenRouter",
  kind: "openrouter",
  base_url: "https://openrouter.ai/api/v1",
  key_cipher: seal(providerKey, "sk-or"),
  model: "~typesafe/jev-latest",
  price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
};
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-sonnet-5-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
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
    expect(stats).toEqual({ groups: 1, items: 1, skipped: 0, failed: 0, learned: 0, checked: 0 });
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
    expect(stats).toEqual({ groups: 0, items: 0, skipped: 1, failed: 0, learned: 0, checked: 0 });
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

describe("o Jev nas situações novas", () => {
  const people = new Map(material().people.map((p) => [p.id, p]));
  const base = {
    item_id: null,
    kind: "question" as const,
    summary: "",
    urgency: 1,
    mentions: [{ message_id: msg(2), quote: "" }],
    task_id: null,
    radar_item_id: null,
  };
  const list = [
    { ...base, title: "Quando sai a arte", owners: [{ user_id: duda, reason: "mention" as const, why: "" }, { user_id: bruno, reason: "role" as const, why: "" }] },
    { ...base, title: "Bom dia pessoal", owners: [{ user_id: bruno, reason: "general" as const, why: "" }] },
    { ...base, title: "Relatório", owners: [{ user_id: bruno, reason: "role" as const, why: "" }, { user_id: duda, reason: "role" as const, why: "" }] },
  ];
  it("pergunta se é situação e, para quem foi escolhido pelo assunto, se é com a pessoa", () => {
    const q = checkQuestions(list, people);
    expect(Object.keys(q)).toEqual(["ok_1", "own_1_2", "ok_2", "own_2_1", "ok_3", "own_3_1", "own_3_2"]);
    expect(q.own_1_2.instructions).toMatch(/com Bruno Tráfego pelo que essa pessoa faz \(equipes: Tráfego\) — o que é com ela: Campanhas/);
  });
  it("tira a que não é situação e o dono que não é dono; sempre fica um", () => {
    const out = applyCheck(list, {
      answers: {
        ok_1: { noul: 0.9 },
        own_1_2: { noul: 0.1 },
        ok_2: { noul: 0.05 },
        ok_3: { noul: 0.8 },
        own_3_1: { noul: 0.2 },
        own_3_2: { noul: 0.25 },
      },
    } as never);
    expect(out.map((c) => c.title)).toEqual(["Quando sai a arte", "Relatório"]);
    expect(out[0].owners.map((o) => o.user_id)).toEqual([duda]);
    // Os dois recusados: fica o mais provável.
    expect(out[1].owners.map((o) => o.user_id)).toEqual([duda]);
  });
});

const lesson = "00000000-0000-4000-8000-0000000000aa";
const fb = (n: number) => `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`;
function learningClaim(): LearningClaim {
  return {
    company,
    user: bruno,
    person: { name: "Bruno Tráfego", about: "Campanhas.", teams: ["Tráfego"] },
    lessons: [{ id: lesson, kind: "reply", text: "Seja breve.", status: "active", origin: "mavi" }],
    feedback: [
      { id: fb(1), action: "not_mine", note: "Arte é com a Duda.", kind: "request", title: "Arte nova", why: "Pelo assunto", at: "02/10 09:00" },
      { id: fb(2), action: "edited", kind: "complaint", title: "CPL alto", draft: "Prezado Carlos", final: "Oi Carlos", at: "02/10 09:10" },
      { id: fb(3), action: "rejected", reason: "wrong_tone", at: "02/10 09:20" },
    ],
  };
}

describe("aprendizado da pessoa", () => {
  it("mostra os retornos com o que a MAVI fez e o que a pessoa mudou", () => {
    const text = learningMessage(learningClaim());
    expect(text).toMatch(/- id 0+.*aa · reply · em uso: Seja breve\./);
    expect(text).toMatch(/\[F1\] 02\/10 09:00 · não é comigo\n  situação: solicitação: Arte nova\n  a MAVI tinha escolhido por: Pelo assunto\n  nota: Arte é com a Duda\./);
    expect(text).toMatch(/\[F2\].*editou a resposta.*\n.*\n  resposta da MAVI: Prezado Carlos\n  o que a pessoa mandou: Oi Carlos/);
    expect(text).toMatch(/\[F3\] .*reprovou a resposta \(tom errado\)/);
  });
  it("troca os [F#] pelos ids e só mexe nas lições que existem", () => {
    const ops = parseLearningOps(
      JSON.stringify({
        ops: [
          { op: "add", kind: "detection", text: "Arte e criativo são da Duda.", feedback: ["F1"] },
          { op: "add", kind: "outro", text: "Tipo inválido." },
          { op: "update", id: lesson, text: "Seja breve e chame pelo nome.", feedback: ["F2", "F9"] },
          { op: "retire", id: "00000000-0000-4000-8000-000000009999" },
        ],
      }),
      learningClaim(),
    );
    expect(ops).toEqual([
      { op: "add", kind: "detection", text: "Arte e criativo são da Duda.", feedback: [fb(1)] },
      { op: "update", id: lesson, text: "Seja breve e chame pelo nome.", feedback: [fb(2)] },
    ]);
  });
  it("o worker aprende depois de ler os grupos e confere as promoções (sem Jev, entra direto)", async () => {
    let learn = 0;
    let check = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": [],
      "rpc/ai_worker_route": null,
      "rpc/ai_personal_radar_config": { jev: null },
      "rpc/ai_personal_radar_learning_claim": () => (learn++ === 0 ? learningClaim() : null),
      "rpc/ai_personal_radar_learning_store": 1,
      "rpc/ai_personal_radar_check_claim": () =>
        check++ === 0 ? { id: lesson, company, scope: "team", kind: "reply", text: "Seja breve.", target: "Tráfego", others: [], jev: null } : null,
      "rpc/ai_personal_radar_check_store": null,
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.instructions).toMatch(/aprender com os retornos desta pessoa/);
      const meter = newMeter("claude-sonnet-5-5");
      meter.cost = 0.003;
      return { text: JSON.stringify({ ops: [{ op: "add", kind: "detection", text: "Arte é da Duda.", feedback: ["F1"] }] }), meter, rounds: 1 };
    });
    const stats = await runPersonalRadar({ ...env, personalRadarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    expect(stats).toMatchObject({ learned: 1, checked: 1, failed: 0 });
    const store = calls.find((c) => c.url.includes("rpc/ai_personal_radar_learning_store"))!;
    expect(store.body).toMatchObject({ p_company: company, p_user: bruno, p_learned: [fb(1), fb(2), fb(3)] });
    expect(store.body.p_ops).toEqual([{ op: "add", kind: "detection", text: "Arte é da Duda.", feedback: [fb(1)] }]);
    expect(store.body.p_usage.cost).toBe(0.003);
    const checked = calls.find((c) => c.url.includes("rpc/ai_personal_radar_check_store"))!;
    expect(checked.body).toMatchObject({ p_lesson: lesson, p_ok: true });
  });
  it("com o Jev, a promoção que não vale para todos é recusada com o motivo", async () => {
    let check = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": [],
      "rpc/ai_personal_radar_learning_claim": null,
      "rpc/ai_personal_radar_check_claim": () =>
        check++ === 0 ? { id: lesson, company, scope: "client", kind: "detection", text: "O Bruno odeia o Carlos.", target: "4282", others: [], jev: jevRoute } : null,
      "rpc/ai_personal_radar_check_store": null,
      "alpha/decisions": (b: any) => {
        expect(Object.keys(b.questions)).toEqual(["general", "safe"]);
        expect(b.state.licao).toBe("O Bruno odeia o Carlos.");
        return { model: "typesafe/jev-1.13", answers: { general: { noul: 0.2 }, safe: { noul: 0.1 } }, usage: { input_tokens: 300, cost: 0.00001 } };
      },
    });
    await runPersonalRadar({ ...env, personalRadarBudgetMs: 400_000 }, { fetch: fetchImpl, llm: vi.fn(), embed });
    const checked = calls.find((c) => c.url.includes("rpc/ai_personal_radar_check_store"))!;
    expect(checked.body.p_ok).toBe(false);
    expect(checked.body.p_note).toMatch(/parece valer só para uma pessoa.*dado sensível/);
    expect(checked.body.p_usage).toMatchObject({ input: 300, provider: "OpenRouter" });
    expect(lessonQuestions({ scope: "team", target: "Tráfego" } as never).general.instructions).toMatch(/equipe "Tráfego"/);
  });
});

describe("a leitura com o Jev e as lições", () => {
  it("as lições de cada pessoa vão no texto; o Jev tira o item novo que não é situação e soma o custo", async () => {
    let claims = 0;
    const { fetchImpl, calls } = database({
      "rpc/ai_personal_radar_claim": () => (claims++ === 0 ? [{ group_id: group, company_id: company }] : []),
      "rpc/ai_personal_radar_material": material(),
      "rpc/ai_worker_route": null,
      "rpc/ai_personal_radar_config": { jev: jevRoute },
      "rpc/ai_personal_radar_lessons": { [bruno]: [{ text: "Arte não é com você." }] },
      "rpc/ai_personal_radar_store": 1,
      "rpc/ai_personal_radar_learning_claim": null,
      "rpc/ai_personal_radar_check_claim": null,
      "alpha/decisions": { answers: { ok_1: { noul: 0.95 }, ok_2: { noul: 0.05 } }, usage: { input_tokens: 400, cost: 0.002 } },
    });
    const llm: LlmAdapter = vi.fn(async (req) => {
      expect(req.messages[0].content).toMatch(/P1 Bruno Tráfego .* o que você aprendeu com ela \(siga\): Arte não é com você\./);
      const meter = newMeter("claude-sonnet-5-5");
      meter.cost = 0.01;
      return {
        text: JSON.stringify({
          items: [
            { kind: "question", title: "Quando sai a arte nova", lines: ["L2"] },
            { kind: "request", title: "Bom dia sem pedido", lines: ["L4"] },
            { item: "I1", kind: "complaint", lines: ["L1"] },
          ],
        }),
        meter,
        rounds: 1,
      };
    });
    await runPersonalRadar({ ...env, personalRadarBudgetMs: 400_000 }, { fetch: fetchImpl, llm, embed });
    const store = calls.find((c) => c.url.includes("rpc/ai_personal_radar_store"))!;
    expect(store.body.p_result.items.map((i: any) => i.title || i.item_id)).toEqual([item, "Quando sai a arte nova"]);
    expect(store.body.p_result.usage.cost).toBe(0.012);
  });
});
