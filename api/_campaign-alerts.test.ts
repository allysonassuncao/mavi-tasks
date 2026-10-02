import { describe, expect, it, vi } from "vitest";
import { streamAi, type AiEnv, type AiStreamEvent } from "./_ai";
import type { AgentRequest, LlmAdapter } from "./_ai-llm";
import { handleCampaignAlertWriter, parseDraft } from "./_campaign-alerts";
import { newMeter } from "./_social-leads";

const company = "00000000-0000-4000-8000-000000000001";
const me = "00000000-0000-4000-8000-000000000003";
const vitt = "00000000-0000-4000-8000-0000000000b1";
const outro = "00000000-0000-4000-8000-0000000000b2";
const motion = "00000000-0000-4000-8000-0000000000a1";
const busca = "00000000-0000-4000-8000-0000000000a2";
const rule1 = "00000000-0000-4000-8000-0000000000d1";
const conversation = "00000000-0000-4000-8000-0000000000c1";
const token = (sub: string) => `Bearer x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;
const env: AiEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-ant",
  model: "claude-opus-5",
  openaiKey: "sk-openai",
  embeddingModel: "text-embedding-3-small",
  workerSecret: "s".repeat(40),
  workerBudgetMs: 60_000,
  providerKey: null,
  imageModel: "gpt-image-1",
};

type Call = { url: string; body: any };
function world(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : []), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const campaigns = [
  {
    id: motion,
    name: "Motion - Meta",
    platform: "meta",
    status: "active",
    contracts: { clients: { name: "Vittalium" }, products: { name: "Make Ads" } },
  },
  {
    id: busca,
    name: "Busca - Google",
    platform: "google",
    status: "active",
    contracts: { clients: { name: "Outro" }, products: { name: "Make Ads" } },
  },
];
const catalog = {
  "ad_campaigns?": campaigns,
  "clients?select=id,name&company_id": [
    { id: vitt, name: "Vittalium" },
    { id: outro, name: "Outro" },
  ],
  "products?": [],
  "teams?": [],
};
const answer = (text: string) => ({ text, meter: newMeter("claude-opus-5"), rounds: 1 });

describe("Descreva o aviso (campaign-alert-mavi)", () => {
  it("lê o JSON com ou sem cercas", () => {
    expect(parseDraft('```json\n{"rule":{"metric":"spend"},"note":"ok"}\n```')).toEqual({
      rule: { metric: "spend" },
      note: "ok",
    });
    expect(parseDraft("nada aqui")).toBeNull();
  });

  it("a descrição vira a regra com os nomes; ids que a pessoa não enxerga caem", async () => {
    const { fetchImpl, calls } = world({
      ...catalog,
      "rpc/campaign_alert_rules": [],
      "rpc/ai_check_limits": { blocked: false, message: null },
      "rpc/ai_resolve_route": null,
      "rpc/ai_log_usage": null,
    });
    let seen: AgentRequest | undefined;
    const llm: LlmAdapter = async (r) => {
      seen = r;
      return answer(
        JSON.stringify({
          rule: {
            metric: "conversions",
            condition: "zero",
            days: 3,
            client_ids: [vitt, "00000000-0000-4000-8000-0000000000ff"],
            platforms: ["meta"],
          },
          note: "Avisa quando as campanhas do Vittalium no Meta ficarem 3 dias sem conversão.",
        }),
      );
    };
    const res = await handleCampaignAlertWriter(
      { company, text: "3 dias sem conversão nas do Vittalium no Meta", campaign: null },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
    );
    expect(res.status).toBe(200);
    expect(seen!.context).toContain(`${motion} | Motion - Meta | Vittalium › Make Ads | meta`);
    expect(res.body.rule).toMatchObject({
      name: "Sem conversões por 3 dias",
      metric: "conversions",
      condition: "zero",
      period: "days",
      client_ids: [vitt],
      platforms: ["meta"],
      labels: { clients: ["Vittalium"] },
    });
    expect(res.body.problem).toBeUndefined();
    const usage = calls.find((c) => c.url.includes("ai_log_usage"))!;
    expect(usage.body).toMatchObject({ p_module: "campaigns", p_kind: "campaign_alerts" });
  });

  it("quem não usa Campanhas para antes da MAVI", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("campaign_alert_rules")
        ? new Response(JSON.stringify({ message: "Sem permissão: Campanhas não está disponível para você" }), {
            status: 403,
          })
        : new Response("[]"),
    ) as unknown as typeof fetch;
    const llm = vi.fn();
    const res = await handleCampaignAlertWriter({ company, text: "me avisa de tudo" }, token(me), env, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    });
    expect(res.status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("avisos de campanhas na conversa", () => {
  const routes = (role: string, shown: string[] = []) => ({
    "memberships?": [{ user_id: me, name: "Ana", email: "ana@x.com", role, active: true, shown_pages: shown }],
    "clients?select=id,name&company_id=eq": [
      { id: vitt, name: "Vittalium" },
      { id: outro, name: "Outro" },
    ],
    "ad_campaigns?": campaigns,
    "products?": [],
    "teams?": [],
    "rpc/campaign_alert_rules": [
      {
        id: rule1,
        name: "Consumo travado",
        campaign_id: motion,
        client_ids: [],
        product_ids: [],
        platforms: [],
        objectives: [],
        team_ids: [],
        metric: "spend",
        condition: "unchanged",
        period: "days",
        days: 3,
        value: null,
        tolerance: 0,
        with_m: false,
        repeat: "once",
        repeat_days: 3,
        channel: "now",
        active: true,
        labels: { campaign: "Motion - Meta", campaign_client: "Vittalium", clients: [], products: [], teams: [] },
        last_hit: null,
      },
    ],
    "rpc/ai_check_limits": { blocked: false, message: null, warnings: [] },
    "rpc/ai_resolve_route": null,
    "rpc/ai_save_turn": conversation,
    "rpc/ai_log_usage": null,
    "rpc/ai_log_tool_calls": null,
  });

  it("na bolinha: lista, propõe pelo nome da campanha e muda um aviso existente", async () => {
    const { fetchImpl } = world(routes("manager"));
    let request: AgentRequest | undefined;
    const outputs: string[] = [];
    const llm: LlmAdapter = async (r) => {
      request = r;
      outputs.push(String(await r.execute("campaign_alerts", {})));
      outputs.push(
        String(
          await r.execute("propose_campaign_alert", {
            op: "create",
            campaign: "motion",
            metric: "cpa",
            condition: "above",
            period: "cycle",
            value: 30,
          }),
        ),
      );
      outputs.push(String(await r.execute("propose_campaign_alert", { op: "update", rule_id: rule1, active: false })));
      outputs.push(String(await r.execute("propose_campaign_alert", { op: "create", campaign: "Nada", metric: "spend", condition: "zero", days: 2 })));
      outputs.push(String(await r.execute("propose_campaign_alert", { op: "create", metric: "spend", condition: "above" })));
      return answer("Pronto:\n[[A1]]\n[[A2]]");
    };
    const events: AiStreamEvent[] = [];
    await streamAi(
      { action: "ai-ask", company, scope: {}, question: "Me avisa se o CPL da Motion passar de 30" },
      token(me),
      env,
      { fetch: fetchImpl, llm, embed: vi.fn() },
      (e) => events.push(e),
    );
    expect(request!.instructions).toContain("Avisos de campanhas");
    expect(outputs[0]).toContain(`${rule1} | Consumo travado | Consumo igual por 3 dias`);
    expect(outputs[1]).toMatch(/^Proposta pronta como A1: Custo por resultado \(no ciclo\) a partir de R\$ 30,00/);
    expect(outputs[2]).toMatch(/^Proposta pronta como A2: Consumo travado/);
    expect(outputs[3]).toMatch(/Não achei a campanha “Nada”/);
    expect(outputs[4]).toMatch(/^O aviso ainda não fecha: Diga o valor do limite/);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.artifacts).toHaveLength(2);
    expect(done.artifacts[0]).toMatchObject({
      type: "action",
      state: "pending",
      action: {
        kind: "campaign_alert",
        op: "create",
        rule: { campaign_id: motion, metric: "cpa", value: 30, origin: "mavi", labels: { campaign: "Motion - Meta" } },
      },
    });
    expect(done.artifacts[1]).toMatchObject({
      action: { op: "update", rule: { id: rule1, active: false, condition: "unchanged", days: 3 } },
    });
  });

  it("sem Campanhas (colaborador sem o módulo), as ferramentas nem aparecem", async () => {
    const { fetchImpl } = world(routes("member"));
    let names: string[] = [];
    const llm: LlmAdapter = async (r) => {
      names = r.tools.map((t) => t.name);
      expect(r.instructions).not.toContain("Avisos de campanhas");
      return answer("Ok.");
    };
    await streamAi({ action: "ai-ask", company, scope: {}, question: "Oi" }, token(me), env, {
      fetch: fetchImpl,
      llm,
      embed: vi.fn(),
    }, () => {});
    expect(names).not.toContain("propose_campaign_alert");
    const on = world(routes("member", ["campaigns"]));
    await streamAi({ action: "ai-ask", company, scope: {}, question: "Oi" }, token(me), env, {
      fetch: on.fetchImpl,
      llm: async (r) => {
        names = r.tools.map((t) => t.name);
        return answer("Ok.");
      },
      embed: vi.fn(),
    }, () => {});
    expect(names).toContain("propose_campaign_alert");
  });
});
