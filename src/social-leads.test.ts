import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatPhoneBR,
  formatUsd,
  moneyFromDigits,
  parseColors,
  parseMoney,
  phoneComplete,
  serializeColors,
  usageSummary,
  briefingReadiness,
  complianceFlags,
  editPost,
  hasNoDigitalPresence,
  missingChannel,
  nextActions,
  parseImport,
  stageOf,
  type PlanContent,
  type PortfolioItem,
} from "./social-leads";

function plan(): PlanContent {
  return {
    diagnostico: { negocio: "Rede de agentes", comoQuerSerVista: "Confiável" },
    swot: { forcas: "F", fraquezas: "Fr", oportunidades: "O", ameacas: "A" },
    pilares: [1, 2, 3, 4].map((n) => ({ titulo: `P${n}`, descricao: `D${n}` })),
    publico: "25 a 55 anos",
    campanha: {
      objetivo: "Cadastros",
      regiao: "Brasil",
      idadeGenero: "25–55",
      segmentacao: "Interesses",
      posicionamentos: "Advantage+",
      orcamento: "R$ 500/mês",
      perguntasFormulario: ["Nome"],
      roteamentoLead: "CRM",
    },
    alertas: ["Bloqueio: sem Instagram"],
    posts: Array.from({ length: 8 }, (_, i) => ({
      numero: i + 1,
      badge: "posicionar" as const,
      gancho: `Gancho ${i + 1}`,
      direcaoCopy: "Copy",
      direcaoVisual: "Visual",
      formato: "Imagem única",
      cta: "Seguir",
      ehAnuncio: i === 3,
      status: i === 0 ? ("aprovado" as const) : ("pendente" as const),
      observacao: "",
    })),
  };
}
const opened = {
  clientSlugs: ["agente-stravitta"],
  planId: "plan-1",
  planLabel: "Mês 1",
};
const json = (alteracoes: object, extra: object = {}) =>
  JSON.stringify({
    tipo: "social-leads-atualizacao",
    cliente: "agente-stravitta",
    plano: "mes-1",
    resumo: "Ajustes",
    alteracoes,
    ...extra,
  });

describe("presença digital", () => {
  it("reconhece canal escrito que ainda não existe", () => {
    for (const v of [
      "",
      "Criar página",
      "criar",
      "nao tem",
      "Não tem",
      "ainda não",
      "-",
      "n/a",
    ])
      expect(missingChannel(v)).toBe(true);
    for (const v of [
      "@orenatolive",
      "https://agente.astravitta.com.br/",
      "dani_maurano",
    ])
      expect(missingChannel(v)).toBe(false);
  });
  it("sem canal e sem cores, o plano não é gerado", () => {
    const f = {
      clientName: "X",
      fbHandle: "Criar página",
      websiteUrl: "nao tem",
    };
    expect(hasNoDigitalPresence(f)).toBe(true);
    const r = briefingReadiness(f, null);
    expect(r.blockers).toEqual([
      expect.stringContaining("informe as cores da marca"),
    ]);
    expect(
      briefingReadiness({ ...f, brandColors: "azul" }, "ctwa").blockers,
    ).toEqual([]);
  });
  it("aponta vertical sensível e falta de prova social", () => {
    const r = briefingReadiness(
      { clientName: "Agente", segment: "Afiliados", igHandle: "@a" },
      "form_nativo",
    );
    expect(r.blockers).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/Vertical sensível/);
    expect(r.warnings.join(" ")).toMatch(/Sem prova social/);
  });
});

describe("importador do chat", () => {
  it("atualização parcial: só o que veio muda e o post avaliado volta a pendente", () => {
    const r = parseImport(
      json({
        posts: [{ numero: 1, gancho: "Novo gancho" }],
        publico: "30 a 50",
      }),
      plan(),
      opened,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.posts[0]).toMatchObject({
      gancho: "Novo gancho",
      status: "pendente",
    });
    expect(r.content.posts[1].gancho).toBe("Gancho 2");
    expect(r.content.publico).toBe("30 a 50");
    expect(r.changes).toEqual(["Post 1: gancho", "Público"]);
    expect(r.reopened).toEqual([1]);
    expect(r.summary).toBe("Ajustes");
  });
  it("aceita cercas de markdown", () => {
    const r = parseImport(
      "```json\n" + json({ publico: "Novo" }) + "\n```",
      plan(),
      opened,
    );
    expect(r.ok).toBe(true);
  });
  it.each([
    ["{", /não é um JSON válido/],
    ["[]", /precisa ser um objeto/],
    [JSON.stringify({ tipo: "outro" }), /social-leads-atualizacao/],
    [json({}, { cliente: "outro-cliente" }), /outro cliente/],
    [
      json({ posts: [{ numero: 2, badge: "venda" }] }),
      /Pilar do post 2 inválido/,
    ],
    [json({ posts: [{ numero: 9, gancho: "x" }] }), /fora de 1 a 8/],
    [json({ posts: [{ numero: 2 }, { numero: 2 }] }), /Post 2 repetido/],
    [
      json({ posts: Array.from({ length: 9 }, (_, i) => ({ numero: i + 1 })) }),
      /Mais de 8/,
    ],
    [
      json({ posts: [{ numero: 3, cta: "  " }] }),
      /CTA do post 3 ficaria vazio/,
    ],
    [json({ pilares: [{ titulo: "a", descricao: "b" }] }), /exatamente 4/],
    [json({ posts: [{ numero: 5, ehAnuncio: true }] }), /ficaria com 2/],
    [json({ swot: { inventado: "x" } }), /Campo desconhecido em swot/],
  ])("recusa %s", (text, error) => {
    const r = parseImport(text, plan(), opened);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });
  it("troca o anúncio quando os dois lados vêm no JSON", () => {
    const r = parseImport(
      json({
        posts: [
          { numero: 4, ehAnuncio: false },
          { numero: 6, ehAnuncio: true },
        ],
      }),
      plan(),
      opened,
    );
    expect(
      r.ok && r.content.posts.filter((p) => p.ehAnuncio).map((p) => p.numero),
    ).toEqual([6]);
  });
  it("avisa quando o plano é outro ou nada muda", () => {
    const r = parseImport(json({}, { plano: "mes-2" }), plan(), opened);
    expect(r.ok && r.warnings).toEqual([
      expect.stringContaining('"mes-2"'),
      "Nada muda no plano com este JSON.",
    ]);
  });
  it("edição manual move o anúncio", () => {
    const next = editPost(plan(), 2, { ehAnuncio: true, gancho: "Outro" });
    expect(next.posts.filter((p) => p.ehAnuncio).map((p) => p.numero)).toEqual([
      2,
    ]);
    expect(next.posts[1].gancho).toBe("Outro");
  });
});

describe("checagem de promessas", () => {
  it("marca promessa no texto pedido para a arte", () => {
    const p = plan().posts;
    p[3].direcaoVisual = 'Arte com o texto "Renda GARANTIDA"';
    p[5].gancho = "Ganhe R$ 3.000 em 30 dias";
    const flags = complianceFlags(p);
    expect(flags).toContainEqual(
      expect.objectContaining({
        post: 4,
        field: "Texto pedido para a arte",
        term: "GARANTIDA",
      }),
    );
    expect(flags.filter((f) => f.post === 6).map((f) => f.why)).toEqual([
      expect.stringContaining("valor em dinheiro"),
      "prazo de resultado",
    ]);
    expect(complianceFlags(plan().posts)).toEqual([]);
  });
});

describe("etapas e próximas ações", () => {
  const now = new Date("2026-09-25T12:00:00Z").getTime();
  const item = (over: Partial<PortfolioItem>): PortfolioItem => ({
    contract_id: "k",
    contract_name: "Social Leads",
    client_id: "c",
    client_name: "Cliente",
    client_color: "#999",
    contract_created_at: "2026-09-01T00:00:00Z",
    can_write: true,
    briefing: {
      fields: {},
      campaign_objective: null,
      responsible_id: null,
      updated_at: "2026-09-24T12:00:00Z",
    },
    plan_count: 0,
    plan: null,
    job: null,
    ...over,
  });
  const p = (over: object) => ({
    id: "p",
    month_number: 1,
    label: "Mês 1",
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    share_enabled: true,
    shared_at: "2026-09-21T12:00:00Z",
    alerts: 0,
    first_alert: null,
    approved: 0,
    rejected: 0,
    last_decision_at: null,
    ...over,
  });
  it("calcula a etapa", () => {
    expect(stageOf(item({}))).toBe(0);
    expect(stageOf(item({ plan: p({ share_enabled: false }) }))).toBe(1);
    expect(stageOf(item({ plan: p({ approved: 5 }) }))).toBe(2);
    expect(stageOf(item({ plan: p({ approved: 8 }) }))).toBe(3);
  });
  it("ordena do mais urgente e diz o que fazer", () => {
    const list = nextActions(
      [
        item({ contract_id: "a", client_name: "A", plan: p({ approved: 8 }) }),
        item({ contract_id: "b", client_name: "B", plan: p({ approved: 2 }) }),
        item({
          contract_id: "c",
          client_name: "C",
          plan: p({ first_alert: "Bloqueio: criar o Instagram" }),
        }),
        item({ contract_id: "d", client_name: "D", briefing: null }),
        item({
          contract_id: "e",
          client_name: "E",
          plan: p({ approved: 8, created_at: "2026-08-20T00:00:00Z" }),
        }),
      ],
      now,
    );
    expect(list.map((a) => [a.contract, a.tone, a.action])).toEqual([
      ["c", "bad", "open-plan"],
      ["b", "warn", "share"],
      ["e", "warn", "next-month"],
      ["a", "good", "open-plan"],
      ["d", "info", "open-briefing"],
    ]);
    expect(list[0].title).toBe("C: criar o Instagram");
    expect(list[1].title).toBe("B: aprovação parada há 4 dias");
  });
});

describe("máscaras do briefing", () => {
  it("celular brasileiro com o 9", () => {
    expect(formatPhoneBR("11912345678")).toBe("(11) 91234-5678");
    expect(formatPhoneBR("+55 (11) 91234-5678")).toBe("(11) 91234-5678");
    expect(formatPhoneBR("1197450725")).toBe("(11) 9745-0725");
    expect(formatPhoneBR("119")).toBe("(11) 9");
    expect(formatPhoneBR("1191234567899")).toBe("(11) 91234-5678");
    expect(phoneComplete("(11) 91234-5678")).toBe(true);
    expect(phoneComplete("(11) 3456-7890")).toBe(false);
  });
  it("moeda: digita pelos centavos e troca a moeda", () => {
    expect(moneyFromDigits("120000", "BRL")).toBe(1200);
    expect(formatMoney(1200, "BRL")).toBe("R$ 1.200,00");
    expect(formatMoney(1200, "USD")).toBe("US$ 1.200,00");
    expect(formatMoney(1200, "EUR")).toBe("€ 1.200,00");
    expect(formatMoney(1200, "GBP")).toBe("£ 1.200,00");
    expect(moneyFromDigits("1200", "JPY")).toBe(1200);
    expect(moneyFromDigits("", "BRL")).toBeNull();
  });
  it("moeda: lê o que já estava salvo", () => {
    expect(parseMoney("US$ 1.200,00")).toEqual({
      code: "USD",
      amount: 1200,
      legacy: null,
    });
    expect(parseMoney("€ 99,90")).toEqual({
      code: "EUR",
      amount: 99.9,
      legacy: null,
    });
    expect(parseMoney("500,00")).toEqual({
      code: "BRL",
      amount: 500,
      legacy: null,
    });
    expect(parseMoney("1200")).toEqual({
      code: "BRL",
      amount: 1200,
      legacy: null,
    });
    // A faixa antiga do Stravitta fica como estava até alguém digitar.
    expect(parseMoney("R$150,00 á R$700,00")).toMatchObject({
      amount: null,
      legacy: "R$150,00 á R$700,00",
    });
  });
  it("cores: várias, com ou sem hex", () => {
    const list = parseColors(
      "azul-marinho #0B1D3A, verde-água #14b8a6; rosa e amarelo",
    );
    expect(list).toEqual([
      { hex: "#0b1d3a", name: "azul-marinho" },
      { hex: "#14b8a6", name: "verde-água" },
      { hex: null, name: "rosa" },
      { hex: null, name: "amarelo" },
    ]);
    expect(serializeColors(list)).toBe(
      "azul-marinho #0b1d3a, verde-água #14b8a6, rosa, amarelo",
    );
    expect(parseColors("#fff")).toEqual([{ hex: "#ffffff", name: "" }]);
  });
  it("custo da IA por plano", () => {
    const row = (kind: "generate" | "adjust", cost: number | string) => ({
      kind,
      model: "claude-opus-5",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: cost,
      created_at: "",
      created_by: null,
    });
    const s = usageSummary([
      row("generate", "0.38"),
      row("adjust", 0.03),
      row("adjust", 0.02),
    ]);
    expect(s.total).toBeCloseTo(0.43);
    expect(s.generations).toBe(1);
    expect(s.adjustments).toBe(2);
    expect(s.tokens).toBe(450);
    expect(formatUsd(0.43)).toBe("US$ 0,43");
    expect(formatUsd(0.001)).toBe("menos de US$ 0,01");
  });
});
