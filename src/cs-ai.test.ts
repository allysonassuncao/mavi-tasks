import { describe, expect, it } from "vitest";
import { CS_TOOLS, runCsTool, type CsAiData } from "./cs-ai";
import { demoCsData } from "./cs-dashboard";
import { kpiStripData } from "./cs-blocks";
import { engineFor } from "./cs-sources";
import { monthStart } from "./cs-engine";

// As ferramentas de CS da MAVI e do MCP (os 20 nomes do conector antigo),
// na carteira inventada da demonstração.
const base = demoCsData();
const all: CsAiData = { ...base, access: { scope: "all" } };
const sq = base.squads[0];
const own: CsAiData = { ...base, squads: base.squads.map((s, i) => (i === 0 ? { ...s, aliases: ["1", "Primog"] } : s)),
  access: { scope: "squads", squads: [sq.id] } };
const run = (data: CsAiData, name: string, args: Record<string, unknown> = {}) => JSON.parse(runCsTool(data, name, args));

describe("ferramentas de Customer Success", () => {
  it("são as 20 do conector antigo, e todas respondem", () => {
    expect(CS_TOOLS.map((t) => t.name)).toEqual([
      "cs_listar", "cs_regras", "cs_kpi", "cs_drilldown", "cs_cliente", "cs_search", "cs_gap_recebimento", "cs_meta_gap",
      "cs_funil_trial", "cs_churns", "cs_health_score", "cs_adimplencia", "cs_ativos", "cs_pendentes", "cs_ritmo", "cs_squads",
      "cs_anomalias", "cs_semana", "cs_recebimento", "cs_insights",
    ]);
    const someone = base.clients[0];
    const args: Record<string, Record<string, unknown>> = {
      cs_listar: { o_que: "meses" }, cs_drilldown: { metrica: "faturamento" }, cs_cliente: { id_externo: someone.external_id },
      cs_search: { q: someone.name.slice(0, 5) },
    };
    for (const t of CS_TOOLS) {
      const r = run(all, t.name, args[t.name] ?? {});
      expect(r.erro, t.name).toBeUndefined();
      expect(r.contexto_dados.mes_corrente).toMatch(/EM ABERTO/);
    }
  });
  it("o KPI é o do painel CS Make", () => {
    const k = kpiStripData(engineFor(base), { mes_ref: monthStart(base.today), squad_id: null, dim: "tudo" });
    expect(run(all, "cs_kpi").data.kpi.fat_mes).toBe(k.fat_mes);
  });
  it("as regras trazem os valores em vigor", () => {
    expect(run(all, "cs_regras").data.regra_m1.resumo).toContain("3.000");
  });
});

describe("quem é de um squad vê só o dele", () => {
  it("sem squad, usa o dele; outro squad é recusado; o número antigo funciona", () => {
    const k = kpiStripData(engineFor(own), { mes_ref: monthStart(base.today), squad_id: sq.id, dim: "tudo" });
    expect(run(own, "cs_kpi").data.kpi.fat_mes).toBe(k.fat_mes);
    expect(run(own, "cs_kpi").contexto_dados.escopo).toContain(sq.name);
    expect(run(own, "cs_kpi", { squad: base.squads[1].name }).erro).toMatch(/só vê os dados do seu squad/);
    expect(run(own, "cs_meta_gap", { squad: "1" }).erro).toBeUndefined();
  });
});
