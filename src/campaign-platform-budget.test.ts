import { describe, expect, it } from "vitest";
import { budgetGap, budgetState, itemStatus, platformBudgetFrom, type PlatformBudget } from "./campaign-platform-budget";

const read = (extra: Partial<PlatformBudget> = {}): PlatformBudget => ({
  daily: 150,
  lifetime: 0,
  lifetime_left: 0,
  active: 2,
  total: 2,
  items: [],
  currency: "BRL",
  previous_daily: null,
  changed_at: null,
  read_at: "2026-10-05T14:10:00Z",
  tried_at: "2026-10-05T14:10:00Z",
  error: null,
  ...extra,
});

describe("orçamento na plataforma × recomendado", () => {
  it("verde até 10%, amarelo até 25%, vermelho acima — para mais ou para menos", () => {
    expect(budgetGap(110, 100)).toEqual({ diff: 10, pct: 10, tone: "good" });
    expect(budgetGap(125, 100)).toEqual({ diff: 25, pct: 25, tone: "warn" });
    expect(budgetGap(74, 100)).toEqual({ diff: -26, pct: 26, tone: "bad" });
    // Mesma conta do aviso no banco: o recomendado arredondado em centavos.
    expect(budgetGap(180, 142.857).pct).toBe(26);
  });

  it("sem recomendado (a verba acabou): gastar ainda é 100%; parada é 0%", () => {
    expect(budgetGap(50, 0)).toMatchObject({ pct: 100, tone: "bad" });
    expect(budgetGap(0, 0)).toMatchObject({ pct: 0, tone: "good" });
  });

  it("os estados da linha: aguardando, erro, não encontrada, pausada, vitalício e diário", () => {
    expect(budgetState(null, 100)).toEqual({ kind: "waiting" });
    expect(budgetState(read({ read_at: null, error: "Token expirado" }), 100)).toEqual({ kind: "error", error: "Token expirado" });
    expect(budgetState(read({ total: 0, active: 0 }), 100)).toEqual({ kind: "missing" });
    expect(budgetState(read({ active: 0 }), 100)).toEqual({ kind: "stopped" });
    expect(budgetState(read({ daily: 0, lifetime: 3000 }), 100)).toEqual({ kind: "lifetime" });
    expect(budgetState(read(), 100)).toMatchObject({ kind: "daily", gap: { pct: 50, tone: "bad" } });
    // Com vitalício junto, o diário não é comparado.
    expect(budgetState(read({ lifetime: 3000 }), 100)).toEqual({ kind: "daily", gap: null });
    // Uma tentativa que falhou depois de uma leitura boa mantém a leitura.
    expect(budgetState(read({ error: "Não respondeu" }), 150)).toMatchObject({ kind: "daily", gap: { tone: "good" } });
  });

  it("lê os números do banco (numeric chega como texto)", () => {
    const b = platformBudgetFrom({
      ...read(),
      daily: "150.00",
      lifetime: "0",
      lifetime_left: "0",
      previous_daily: "120.50",
      items: [
        { id: "s1", name: "Conjunto", level: "adset", campaign_id: "c1", active: true, status: "ACTIVE", daily: "150", lifetime: "0", lifetime_left: "0" },
      ],
    });
    expect(b?.daily).toBe(150);
    expect(b?.previous_daily).toBe(120.5);
    expect(b?.items[0].daily).toBe(150);
    expect(platformBudgetFrom(null)).toBeNull();
  });

  it("a situação de cada item, em português", () => {
    expect(itemStatus({ active: true, status: "ACTIVE" })).toBe("entregando");
    expect(itemStatus({ active: false, status: "ADSET_PAUSED" })).toBe("conjunto pausado");
    expect(itemStatus({ active: false, status: "NO_ACTIVE_ADSETS" })).toBe("sem conjunto ativo");
    expect(itemStatus({ active: false, status: "SOMETHING_NEW" })).toBe("something new");
  });
});
