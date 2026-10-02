import { describe, expect, it } from "vitest";
import {
  blankRule,
  conditionText,
  conditionsFor,
  describeRule,
  normalizeRule,
  ruleFromInput,
  ruleProblem,
  scopeText,
  suggestedName,
} from "./campaign-alerts";
import { sanitizeArtifact } from "./mavi-artifacts";

const campaign = "00000000-0000-4000-8000-0000000000a1";
const client = "00000000-0000-4000-8000-0000000000b1";

describe("regras de aviso de campanha", () => {
  it("métricas do ciclo só têm 'chegar a' e 'ficar abaixo de'; zerado só nas contagens", () => {
    expect(conditionsFor("media_left")).toEqual(["above", "below"]);
    expect(conditionsFor("cpa")).not.toContain("zero");
    expect(conditionsFor("spend")).toEqual(["above", "below", "unchanged", "zero", "rise", "drop"]);
  });

  it("ajusta como o banco: o que não vale para a condição volta ao padrão", () => {
    const r = normalizeRule({
      ...blankRule(campaign),
      client_ids: [client],
      metric: "conversions",
      condition: "zero",
      period: "cycle",
      value: 12,
      tolerance: 5,
      with_m: true,
      repeat: "daily",
      repeat_days: 9,
      days: 99,
    });
    expect(r).toMatchObject({
      client_ids: [],
      period: "days",
      value: null,
      tolerance: 0,
      with_m: false,
      repeat_days: 3,
      days: 30,
    });
    expect(normalizeRule({ ...blankRule(), metric: "daily_budget", condition: "above", period: "days", days: 4 }))
      .toMatchObject({ period: "cycle", days: 1 });
  });

  it("as mesmas mensagens do banco para o que falta", () => {
    expect(ruleProblem({ ...blankRule(), name: "" })).toMatch(/nome/);
    const named = { ...blankRule(), name: "Teste" };
    expect(ruleProblem({ ...named, metric: "spend_pace", condition: "unchanged" })).toMatch(/é do ciclo/);
    expect(ruleProblem({ ...named, metric: "ctr", condition: "zero" })).toMatch(/zerados/);
    expect(ruleProblem({ ...named, condition: "above", period: "day", value: null })).toMatch(/limite/);
    expect(ruleProblem({ ...named, condition: "drop", value: 0 })).toMatch(/maior que 0/);
    expect(ruleProblem({ ...named, condition: "unchanged", days: 1 })).toMatch(/2 dias/);
    expect(ruleProblem({ ...named, condition: "unchanged", days: 3 })).toBeNull();
  });

  it("descreve a regra em uma linha", () => {
    const r = normalizeRule({
      ...blankRule(),
      name: "CPL alto",
      metric: "cpa",
      condition: "above",
      period: "cycle",
      value: 30,
      with_m: true,
      repeat: "every",
      repeat_days: 2,
      channel: "digest",
      platforms: ["meta"],
      labels: { campaign: null, campaign_client: null, clients: ["Vittalium"], products: [], teams: [] },
      client_ids: [client],
    });
    expect(conditionText(r)).toBe("Custo por resultado (no ciclo) a partir de R$ 30,00, com M");
    expect(scopeText(r)).toBe("Campanhas ativas: Vittalium · Meta");
    expect(describeRule(r)).toBe(
      "Custo por resultado (no ciclo) a partir de R$ 30,00, com M · Campanhas ativas: Vittalium · Meta · avisa a cada 2 dias enquanto valer · no resumo das 11h",
    );
    expect(conditionText({ ...blankRule(), condition: "unchanged", days: 3, tolerance: 2 })).toBe(
      "Consumo igual por 3 dias (±2%), sem M",
    );
    expect(suggestedName({ ...blankRule(), metric: "conversions", condition: "zero", days: 3 })).toBe(
      "Sem conversões por 3 dias",
    );
    expect(scopeText(blankRule())).toBe("Todas as campanhas ativas");
  });

  it("de fora (MAVI, cartão gravado): só o catálogo entra; o que falta vira erro", () => {
    const { rule, error } = ruleFromInput({
      name: "  Sem conversão ",
      metric: "conversions",
      condition: "zero",
      days: "3",
      platforms: ["meta", "orkut"],
      client_ids: [client, "x", client],
      campaign_id: "nope",
      extra: "ignorado",
    });
    expect(error).toBeNull();
    expect(rule).toMatchObject({
      name: "Sem conversão",
      days: 3,
      platforms: ["meta"],
      client_ids: [client],
      campaign_id: null,
    });
    expect(ruleFromInput({ metric: "nada", condition: "above" }).error).toMatch(/métrica/);
    expect(ruleFromInput({ name: "X1", metric: "spend", condition: "above" }).error).toMatch(/limite/);
  });

  it("o cartão da MAVI com o aviso sobrevive ao saneamento; um quebrado cai", () => {
    const ok = sanitizeArtifact({
      id: "alert-1",
      ref: "A1",
      type: "action",
      state: "pending",
      action: {
        kind: "campaign_alert",
        op: "create",
        rule: { name: "Consumo travado", campaign_id: campaign, metric: "spend", condition: "unchanged", days: 3 },
      },
      result: { rule_id: client },
    });
    expect(ok).toMatchObject({
      action: { kind: "campaign_alert", op: "create", rule: { campaign_id: campaign, days: 3 } },
      result: { rule_id: client },
    });
    expect(
      sanitizeArtifact({
        id: "alert-2",
        ref: "A2",
        type: "action",
        state: "pending",
        action: { kind: "campaign_alert", op: "update", rule: { name: "Sem id", metric: "spend", condition: "zero", days: 2 } },
      }),
    ).toBeNull();
  });
});
