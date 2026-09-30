import { describe, expect, it, vi } from "vitest";
import { describeStep, mediaLine, runTool, summarizeStep, type MediaAiClient, type ToolContext } from "./_ai-tools";
import { sourceLink } from "./_mcp";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const make = "00000000-0000-4000-8000-0000000000a1";

function database(data: unknown, status = 200) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(JSON.stringify(data), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const ctx = (fetchImpl: typeof fetch, scope = {}): ToolContext => ({
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  fetch: fetchImpl,
  auth: "Bearer pessoa",
  company,
  scope,
  embed: vi.fn(),
  members: new Map(),
  clients: new Map([[client, "4282"]]),
  today: "2026-09-30",
  usage: { embeddingTokens: 0, embeddingModel: "" },
  sources: [],
  chunks: new Map(),
});

const row: MediaAiClient = {
  client: true,
  accounts: [
    {
      contract_id: make,
      product_name: "Make Ads",
      archived: false,
      balance: 742.7,
      min_balance: 1000,
      level: "low",
      entries: 40,
      credits: 9000,
      credits_count: 3,
      reversed: 500,
      first_on: "2026-07-01",
      last: { on: "2026-09-28", amount: 3000 },
      period: { credits: 3000, debits: 2257.3, campaign_spend: 2257.3 },
    },
  ],
  monthly: [
    { month: "2026-09", credits: 3000, count: 1 },
    { month: "2026-08", credits: 3000, count: 1 },
  ],
  total: 4,
  credits: [
    {
      id: "e1",
      contract_id: make,
      product_name: "Make Ads",
      occurred_on: "2026-09-28",
      amount: 3000,
      category: "Depósito do cliente",
      reason: "Pix do cliente para a verba de outubro",
      by: "Financeiro",
      created_at: "2026-09-28T14:26:00Z",
      receipts: 1,
      reversed: null,
    },
    {
      id: "e2",
      contract_id: make,
      product_name: "Make Ads",
      occurred_on: "2026-09-10",
      amount: 500,
      category: "Ajuste",
      reason: "Lançado no cliente errado",
      by: "Ana",
      created_at: "2026-09-10T12:00:00Z",
      receipts: 0,
      reversed: { at: "2026-09-11T12:00:00Z", by: "Gabi", reason: "Era de outro cliente" },
    },
  ],
};

describe("a conta de mídia na conversa com a MAVI", () => {
  it("com o cliente: saldo, totais, meses e as entradas com quem lançou, estorno e comprovante", async () => {
    const { fetchImpl, calls } = database(row);
    const c = ctx(fetchImpl, { client });
    const out = await runTool(c, "media_account", { from: "2026-09-01", to: "2026-09-30" });
    expect(calls[0].url).toBe("https://db.example.com/rest/v1/rpc/media_ai");
    expect(calls[0].auth).toBe("Bearer pessoa");
    expect(calls[0].body).toEqual({
      p_company: company,
      p_client: client,
      p_from: "2026-09-01",
      p_to: "2026-09-30",
      p_limit: 30,
    });
    expect(out).toContain("Contas de mídia do cliente 4282");
    expect(out).toContain("Make Ads [S1]: saldo hoje R$ 742,70 (abaixo do mínimo) · mínimo R$ 1.000,00");
    expect(out).toContain("entradas R$ 9.000,00 em 3 (desde 01/07/2026) · última R$ 3.000,00 em 28/09/2026");
    expect(out).toContain("estornado R$ 500,00");
    expect(out).toContain("de 01/09/2026 até 30/09/2026: entrou R$ 3.000,00, saiu R$ 2.257,30");
    expect(out).toContain("09/2026 R$ 3.000,00 (1); 08/2026 R$ 3.000,00 (1)");
    expect(out).toContain(
      "- 28/09/2026 · R$ 3.000,00 · Make Ads [S1] · Depósito do cliente · lançado por Financeiro em 28/09/2026 · 1 comprovante",
    );
    expect(out).toContain("Motivo: Pix do cliente para a verba de outubro");
    expect(out).toContain("ESTORNADA em 11/09/2026 por Gabi: Era de outro cliente");
    expect(summarizeStep("media_account", out)).toBe("2 entradas");
    // One reference per account, which opens its statement.
    expect(c.sources).toEqual([
      expect.objectContaining({ ref: "S1", type: "media", id: make, title: "4282 › Make Ads" }),
    ]);
    expect(sourceLink("https://app.example", c.sources[0])).toBe(
      `https://app.example/financeiro/midia?contrato=${make}`,
    );
  });

  it("sem cliente: a carteira das contas com mais entradas no período", async () => {
    const { fetchImpl, calls } = database({
      client: false,
      accounts_with_credits: 12,
      credits: 45000,
      credits_count: 15,
      accounts: [
        {
          contract_id: make,
          client_id: client,
          client_name: "4282",
          product_name: "Make Ads",
          archived: false,
          credits: 6000,
          credits_count: 2,
          last_on: "2026-09-28",
          balance: -120,
          min_balance: null,
          level: "negative",
        },
      ],
    });
    const c = ctx(fetchImpl);
    const out = await runTool(c, "media_account", { from: "2026-09-01", limit: 5 });
    expect(calls[0].body).toMatchObject({ p_client: null, p_from: "2026-09-01", p_to: null, p_limit: 5 });
    expect(out).toContain("Entradas nas contas de mídia de 01/09/2026 até hoje: R$ 45.000,00 em 15 lançamentos, 12 contas");
    expect(out).toContain("(1 de 12)");
    expect(out).toContain(
      "- Cliente 4282 (id 00000000-0000-4000-8000-000000000002) · Make Ads [S1]: R$ 6.000,00 em 2 entradas, a última em 28/09/2026 · saldo hoje -R$ 120,00 (negativo)",
    );
    expect(summarizeStep("media_account", out)).toBe("1 conta");
    expect(describeStep(c, "media_account", { from: "2026-09-01" })).toBe(
      "Conferindo as entradas das contas de mídia (de 01/09/2026)",
    );
  });

  it("sem o módulo: diz que não dá para ver, sem inventar valores", async () => {
    const { fetchImpl } = database(
      { message: "Sem permissão: Financeiro › Mídia não está disponível para você" },
      403,
    );
    const out = await runTool(ctx(fetchImpl, { client }), "media_account", {});
    expect(out).toMatch(/não tem o Financeiro › Mídia/);
  });

  it("no contexto da conversa do cliente: saldo e última entrada numa linha", () => {
    expect(mediaLine(row)).toBe(
      "Conta de mídia (Financeiro › Mídia): Make Ads: saldo R$ 742,70 (abaixo do mínimo), R$ 9.000,00 em 3 entradas, a última de R$ 3.000,00 em 28/09/2026. Para as entradas, quem lançou, o período e os meses, use media_account.",
    );
    expect(mediaLine(null)).toBe("");
    expect(mediaLine({ ...row, accounts: [] })).toBe("");
  });
});
