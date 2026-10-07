import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dossierLine, streamAi, type AiEnv } from "./_ai";
import type { LlmAdapter } from "./_ai-llm";
import { dossierMessage, handleDossierWorker, type DossierEnv } from "./_copilot";
import { checkDossierOps, MAX_CHECKS } from "./_dossier-check";
import { decideDossierOp, ruleRisk } from "./_dossier-risk";
import { seal } from "./_google";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const tone = "00000000-0000-4000-8000-0000000000d1";
const rule = "00000000-0000-4000-8000-0000000000d2";
const providerKey = crypto.randomBytes(32);
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-sonnet-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey,
};
const denv: DossierEnv = { ...env, dossierModel: "claude-sonnet-5" };
const items = [
  { id: tone, kind: "style", text: "Tom leve, sem gírias.", origin: "mavi" as const, pinned: false, dismissed: false, seen_at: null },
  { id: rule, kind: "rule", text: "Aprovação com a Bia.", origin: "mavi" as const, pinned: false, dismissed: false, seen_at: null },
];

describe("memória por cliente · risco", () => {
  it("regra/combinado e condição comercial pedem confirmação, mesmo sem o Jev", () => {
    expect(ruleRisk({ op: "add", kind: "rule", text: "Aprovação com o Pedro." }, items)).toEqual(["regra ou combinado"]);
    expect(ruleRisk({ op: "add", kind: "context", text: "O orçamento de mídia é R$ 5 mil." }, items)).toEqual(["condição comercial"]);
    expect(ruleRisk({ op: "remove", id: rule }, items)).toEqual(["tira uma regra ou combinado"]);
    expect(ruleRisk({ op: "add", kind: "style", text: "Gosta de fotos claras." }, items)).toEqual([]);
    expect(decideDossierOp({ op: "add" }, ["regra ou combinado"], null).route).toBe("suggest");
    expect(decideDossierOp({ op: "add" }, [], null).route).toBe("apply");
    expect(decideDossierOp({ op: "remove" }, [], { supported: 0.1 }).route).toBe("apply");
  });

  it("o Jev: recusa o que não se sustenta ou é do Termômetro/Radar; contradição e pouca evidência pedem confirmação", () => {
    expect(decideDossierOp({ op: "add" }, [], { supported: 0.9, contradicts: 0.1, elsewhere: 0.1, useful: 0.9 })).toEqual({
      route: "apply",
      reasons: [],
      checks: { supported: 0.9, contradicts: 0.1, elsewhere: 0.1, useful: 0.9 },
    });
    const weak = decideDossierOp({ op: "add" }, [], { supported: 0.3, elsewhere: 0.8 });
    expect(weak.route).toBe("refuse");
    expect(weak.note).toBe("O Jev recusou: o material citado não sustenta; é assunto do Termômetro ou do Radar.");
    expect(decideDossierOp({ op: "add" }, [], { supported: 0.9, useful: 0.2 }).reasons).toEqual(["genérico ou sem uso nas entregas"]);
    expect(decideDossierOp({ op: "update" }, ["regra ou combinado"], { supported: 0.6, contradicts: 0.7 })).toMatchObject({
      route: "suggest",
      reasons: ["regra ou combinado", "contradiz o dossiê", "pouca evidência"],
    });
    expect(decideDossierOp({ op: "add" }, [], {}, false)).toMatchObject({ route: "suggest", reasons: ["sem conferência do Jev"] });
  });

  it("o pedido à MAVI lista o que espera confirmação e o que foi recusado", () => {
    const m = dossierMessage(
      { client_id: client, company_id: company, client_name: "ACME", products: "", cursor_at: null, cursor_id: null, items },
      { docs: [], cursor_at: null, cursor_id: null, more: false },
      { waiting: ["Não usar vermelho."], refused: ["Está insatisfeito."] },
    );
    expect(m).toContain("Aguardando confirmação do time (não repita):\n- Não usar vermelho.");
    expect(m).toContain("Recusado pelo time ou pelo Jev (não proponha de novo):\n- Está insatisfeito.");
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
    return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const jevRoute = {
  provider_id: "00000000-0000-4000-8000-0000000000f1",
  provider: "OpenRouter",
  kind: "openrouter",
  base_url: "https://openrouter.ai/api/v1",
  key_cipher: seal(providerKey, "sk-or"),
  model: "~typesafe/jev-latest",
  price: { id: "~typesafe/jev-latest", input: 0.042, output: 0 },
};
const material = {
  docs: [
    { type: "meeting", title: "Alinhamento", date: "2026-10-01T12:00:00Z", text: "O cliente pediu: aprovação agora com o Pedro." },
    { type: "whatsapp", title: "Grupo", date: "2026-10-02T12:00:00Z", text: "Adorei as fotos claras!" },
  ],
  cursor_at: "2026-10-02T12:00:00Z",
  cursor_id: "00000000-0000-4000-8000-0000000000aa",
  more: false,
};
const claim = { client_id: client, company_id: company, client_name: "ACME", products: "Social", cursor_at: null, cursor_id: null, items };

describe("memória por cliente · a rotina com o Jev", () => {
  it("confere cada mudança com o material e o dossiê; rota por risco; o custo do Jev à parte", async () => {
    let claims = 0;
    const asked: any[] = [];
    const { fetchImpl, calls } = database({
      "rpc/ai_dossier_claim": () => (claims++ === 0 ? [claim] : []),
      "rpc/ai_dossier_material": material,
      "rpc/ai_dossier_proposals": { waiting: ["Não usar vermelho."], refused: [] },
      "rpc/ai_worker_route": null,
      "rpc/mavi_judge_jev": jevRoute,
      "rpc/ai_dossier_store": 2,
      "alpha/decisions": (b: any) => {
        asked.push(b.state);
        const s = b.state.item as string;
        return {
          model: "typesafe/jev-1.13",
          answers: s.includes("fotos claras")
            ? { supported: { noul: 0.92 }, contradicts: { noul: 0.05 }, elsewhere: { noul: 0.1 }, useful: { noul: 0.9 } }
            : s.includes("Pedro")
              ? { supported: { noul: 0.9 }, contradicts: { noul: 0.8 }, elsewhere: { noul: 0.1 }, useful: { noul: 0.9 } }
              : { supported: { noul: 0.2 }, contradicts: { noul: 0.1 }, elsewhere: { noul: 0.9 }, useful: { noul: 0.5 } },
          usage: { input_tokens: 700, cost: 0.00003 },
        };
      },
    });
    const llm: LlmAdapter = async (req) => {
      expect(req.messages[0].content).toContain("Aguardando confirmação do time (não repita):\n- Não usar vermelho.");
      const meter = newMeter("claude-sonnet-5");
      meter.cost = 0.02;
      return {
        text: JSON.stringify({
          ops: [
            { op: "add", kind: "prefers", text: "Gosta de fotos claras.", refs: ["M2"] },
            { op: "update", id: rule, kind: "rule", text: "Aprovação com o Pedro.", refs: ["M1"] },
            { op: "add", kind: "context", text: "Está insatisfeito com o CPL.", refs: ["M1"] },
            { op: "remove", id: tone },
          ],
        }),
        meter,
        rounds: 0,
      };
    };
    const res = await handleDossierWorker(`Bearer ${env.workerSecret}`, denv, { fetch: fetchImpl, llm, embed: vi.fn() }, checkDossierOps);
    expect(res.body).toEqual({ clients: 1, changes: 2, failed: 0 });
    expect(asked).toHaveLength(3);
    const pedro = asked.find((s) => s.item.includes("Pedro"));
    expect(pedro.item_atual).toBe("Aprovação com a Bia.");
    expect(pedro.material_citado[0]).toContain("aprovação agora com o Pedro");
    // As fontes incluem o próprio dossiê (sem o item que muda).
    expect(pedro.dossie_atual).toEqual(["tom e identidade: Tom leve, sem gírias."]);
    const store = calls.find((c) => c.url.includes("rpc/ai_dossier_store"))!;
    const ops = store.body.p_ops;
    expect(ops.map((o: any) => [o.text ?? o.id, o.route])).toEqual([
      ["Gosta de fotos claras.", "apply"],
      ["Aprovação com o Pedro.", "suggest"],
      ["Está insatisfeito com o CPL.", "refuse"],
      [tone, "apply"],
    ]);
    expect(ops[1].reasons).toEqual(["regra ou combinado", "contradiz o dossiê"]);
    expect(ops[2].note).toContain("Termômetro ou do Radar");
    expect(ops.every((o: any) => !("docs" in o))).toBe(true);
    expect(store.body.p_usage).toMatchObject({
      model: "claude-sonnet-5",
      cost: 0.02,
      jev: { model: "typesafe/jev-1.13", input: 2100, cost: 0.00009, provider: "OpenRouter" },
    });
  });

  it("sem o Jev cadastrado, só a regra; o Jev fora do ar manda para confirmação; acima do teto também", async () => {
    const ops = [
      { op: "add", kind: "rule", text: "Aprovação com o Pedro.", sources: [], docs: [0] },
      { op: "add", kind: "prefers", text: "Gosta de fotos claras.", sources: [], docs: [1] },
    ];
    const none = database({ "rpc/mavi_judge_jev": null });
    const a = await checkDossierOps(env, { fetch: none.fetchImpl, llm: vi.fn(), embed: vi.fn() }, claim, material, ops);
    expect(a.ops.map((o) => o.route)).toEqual(["suggest", "apply"]);
    expect(a.usage).toBeNull();
    const down = database({
      "rpc/mavi_judge_jev": jevRoute,
      "alpha/decisions": () => new Response("erro", { status: 500 }),
    });
    const b = await checkDossierOps(env, { fetch: down.fetchImpl, llm: vi.fn(), embed: vi.fn() }, claim, material, ops);
    expect(b.ops.map((o) => [o.route, o.reasons])).toEqual([
      ["suggest", ["regra ou combinado", "sem conferência do Jev"]],
      ["suggest", ["sem conferência do Jev"]],
    ]);
    const many = Array.from({ length: MAX_CHECKS + 2 }, (_, i) => ({ op: "add", kind: "prefers", text: `Item ${i}.`, sources: [] }));
    let n = 0;
    const ok = database({
      "rpc/mavi_judge_jev": jevRoute,
      "alpha/decisions": () => {
        n++;
        return { answers: { supported: { noul: 0.9 }, contradicts: { noul: 0 }, elsewhere: { noul: 0 }, useful: { noul: 0.9 } } };
      },
    });
    const c = await checkDossierOps(env, { fetch: ok.fetchImpl, llm: vi.fn(), embed: vi.fn() }, claim, material, many);
    expect(n).toBe(MAX_CHECKS);
    expect(c.ops.filter((o) => o.route === "apply")).toHaveLength(MAX_CHECKS);
    expect(c.ops.slice(-2).map((o) => o.route)).toEqual(["suggest", "suggest"]);
  });
});

describe("memória por cliente · no chat", () => {
  const me = "00000000-0000-4000-8000-000000000003";
  const conversation = "00000000-0000-4000-8000-0000000000c9";
  const run = "00000000-0000-4000-8000-0000000000e1";
  const proposal = "00000000-0000-4000-8000-0000000000b1";
  const token = `Bearer x.${Buffer.from(JSON.stringify({ sub: me })).toString("base64url")}.y`;

  it("o dossiê entra com [C#] e um teto", () => {
    expect(dossierLine(null)).toBe("");
    const line = dossierLine([
      { id: tone, kind: "style", text: "Tom leve, sem gírias." },
      { id: rule, kind: "rule", text: "Aprovação com a Bia." },
      { id: "x", kind: "context", text: "y".repeat(4000) },
    ]);
    expect(line).toContain("[C1] Tom e identidade: Tom leve, sem gírias. · [C2] Regra: Aprovação com a Bia.");
    expect(line).not.toContain("yyyy");
    expect(line).toContain("contestar pelo botão Memória");
  });

  it("na conversa do cliente: o dossiê no contexto, o cartão “Confere?” no fim e a resposta guarda o que leu", async () => {
    const { fetchImpl, calls } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "clients?": [{ id: client, name: "ACME" }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_my_powers": [],
      "rpc/ai_run_start": { id: run, conversation, created: true },
      "rpc/ai_save_turn": conversation,
      "rpc/ai_usage_close_turn": 321,
      "rpc/client_dossier_context": [
        { id: tone, kind: "style", text: "Tom leve, sem gírias." },
        { id: rule, kind: "rule", text: "Aprovação com a Bia." },
      ],
      "rpc/client_dossier_ask": {
        id: proposal,
        op: "add",
        kind: "avoids",
        text: "Não citar a concorrente.",
        previous: null,
        reasons: ["pouca evidência"],
        sources: [{ type: "whatsapp", title: "Grupo", date: "2026-10-02" }],
        client: "ACME",
      },
      "rpc/mavi_dossier_used": null,
    });
    let context = "";
    const llm: LlmAdapter = async (r) => {
      context = r.context;
      return { text: "Tom leve.", meter: newMeter("claude-opus-5-5"), rounds: 0 };
    };
    const events: any[] = [];
    await streamAi(
      { action: "ai-ask", company, question: "Como é o tom do cliente?", surface: "page", scope: { client } },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
      { onClose: () => {} },
    );
    expect(context).toContain("[C1] Tom e identidade: Tom leve, sem gírias.");
    const card = events.find((e) => e.type === "artifact")?.artifact;
    expect(card).toMatchObject({ type: "dossier_check", proposal, client: "ACME", text: "Não citar a concorrente." });
    const save = calls.find((c) => c.url.endsWith("/rpc/ai_save_turn"))!;
    expect(save.body.p_artifacts[0]).toMatchObject({ type: "dossier_check", proposal });
    expect(calls.find((c) => c.url.endsWith("/rpc/mavi_dossier_used"))!.body).toEqual({ p_message: 321, p_ids: [tone, rule] });
    expect(events.find((e) => e.type === "done")?.dossier).toEqual([tone, rule]);
  });

  it("fora do módulo e da bolinha, sem cartão", async () => {
    const { fetchImpl, calls } = database({
      "memberships?": [{ user_id: me, name: "Ana", email: "", role: "member", active: true }],
      "clients?": [{ id: client, name: "ACME" }],
      "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
      "rpc/ai_resolve_route": null,
      "rpc/ai_save_turn": conversation,
      "rpc/client_dossier_context": [],
    });
    const llm: LlmAdapter = async () => ({ text: "Ok.", meter: newMeter("claude-opus-5-5"), rounds: 0 });
    await streamAi(
      { action: "ai-ask", company, question: "Resumo da reunião?", scope: { client, module: "meetings" } },
      token,
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      () => {},
      { onClose: () => {} },
    );
    expect(calls.some((c) => c.url.includes("client_dossier_ask"))).toBe(false);
  });
});
