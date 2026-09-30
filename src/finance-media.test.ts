import { describe, expect, it, vi } from "vitest";
import {
  coalesce,
  fetchOnce,
  forgetStatements,
  remember,
  remembered,
  statementKey,
  categoriesFor,
  clientStatus,
  toggleStatus,
  demoMedia,
  entryInput,
  levelOf,
  parseMoney,
  summary,
  type MediaAccount,
  type MediaCategory,
} from "./finance-media";
import { emptySnapshot } from "./types";

describe("Financeiro › Mídia", () => {
  it("lê valores em reais digitados de vários jeitos", () => {
    expect(parseMoney("1.234,56")).toBe(1234.56);
    expect(parseMoney("R$ 1.234,56")).toBe(1234.56);
    expect(parseMoney("1234,5")).toBe(1234.5);
    expect(parseMoney("1234.56")).toBe(1234.56);
    expect(parseMoney("1.500")).toBe(1500);
    expect(parseMoney("")).toBeNaN();
    expect(parseMoney("-10")).toBeNaN();
    expect(parseMoney("dez")).toBeNaN();
  });
  it("confere o lançamento como o banco, com mensagens claras", () => {
    const draft = {
      contract: "k",
      kind: "credit" as const,
      amount: "1.000,00",
      occurred_on: "2026-09-30",
      category: "c",
      reason: " Pix do cliente ",
    };
    expect(entryInput(draft, "2026-09-30")).toEqual({
      input: {
        contract: "k",
        kind: "credit",
        amount: 1000,
        occurred_on: "2026-09-30",
        category: "c",
        reason: "Pix do cliente",
      },
    });
    const error = (patch: Partial<typeof draft>) =>
      (entryInput({ ...draft, ...patch }, "2026-09-30") as { error: string }).error;
    expect(error({ contract: "" })).toMatch(/conta/);
    expect(error({ amount: "0" })).toMatch(/maior que zero/);
    expect(error({ amount: "10,555" })).toMatch(/dois decimais/);
    expect(error({ occurred_on: "2026-10-01" })).toMatch(/futura/);
    expect(error({ category: "" })).toMatch(/categoria/);
    expect(error({ reason: "ok" })).toMatch(/motivo/);
  });
  it("nível do saldo: negativo, abaixo do mínimo ou ok", () => {
    expect(levelOf(-0.01, null)).toBe("negative");
    expect(levelOf(0, null)).toBe("ok");
    expect(levelOf(99, 100)).toBe("low");
    expect(levelOf(100, 100)).toBe("ok");
  });
  it("categorias do tipo do lançamento, sem as arquivadas", () => {
    const c = (id: string, kind: MediaCategory["kind"], archived = false) =>
      ({ id, name: id, kind, archived, entries: 0 }) as MediaCategory;
    const list = [c("a", "credit"), c("b", "debit"), c("c", "both"), c("d", "credit", true)];
    expect(categoriesFor(list, "credit").map((x) => x.id)).toEqual(["a", "c"]);
    expect(categoriesFor(list, "debit").map((x) => x.id)).toEqual(["b", "c"]);
  });
  it("resumo: saldo somado e contas negativas e abaixo do mínimo", () => {
    const a = (balance: number, level: MediaAccount["level"]) =>
      ({ balance, level }) as MediaAccount;
    expect(summary([a(100, "ok"), a(-50, "negative"), a(10, "low")])).toEqual({
      balance: 60,
      negative: 1,
      low: 1,
      count: 3,
    });
  });
  it("status do cliente: pelo cadastro de Clientes, ou pela própria conta", () => {
    const clients = [
      { id: "a", archived: false },
      { id: "b", archived: true },
    ];
    expect(clientStatus({ client_id: "a", archived: true }, clients)).toBe("active");
    expect(clientStatus({ client_id: "b", archived: false }, clients)).toBe("archived");
    expect(clientStatus({ client_id: "x", archived: true }, clients)).toBe("archived");
  });
  it("filtro de status: inclui e tira, mas o último marcado fica", () => {
    expect(toggleStatus(["active"], "archived")).toEqual(["active", "archived"]);
    expect(toggleStatus(["active", "archived"], "active")).toEqual(["archived"]);
    expect(toggleStatus(["archived"], "archived")).toEqual(["archived"]);
  });
  it("rajada de avisos ao vivo: recarrega uma vez, no máximo 2 s depois do primeiro", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const reload = coalesce(run, 400, 2000);
      reload();
      vi.advanceTimersByTime(300);
      reload();
      vi.advanceTimersByTime(300);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(run).toHaveBeenCalledTimes(1);
      // A sync that doesn't stop: still one reload every 2 s.
      for (let i = 0; i < 10; i++) {
        reload();
        vi.advanceTimersByTime(250);
      }
      expect(run).toHaveBeenCalledTimes(2);
      reload.cancel();
      vi.advanceTimersByTime(5000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("mesmo pedido ao mesmo tempo vai uma vez, e a resposta fica lembrada", async () => {
    const fetcher = vi.fn(() => Promise.resolve(42));
    const [a, b] = await Promise.all([fetchOnce("t:x", fetcher), fetchOnce("t:x", fetcher)]);
    expect([a, b]).toEqual([42, 42]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(remembered("t:x")).toBe(42);
    // After it arrives, a new question goes again (to refresh).
    await fetchOnce("t:x", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("esquece só os extratos da conta que mudou", () => {
    const f = { from: "", to: "", kind: "", category: "" };
    remember(statementKey("s", "k1", f, 100), 1);
    remember(statementKey("s", "k1", { ...f, kind: "credit" }, 100), 2);
    remember(statementKey("s", "k2", f, 100), 3);
    forgetStatements("s", "k1");
    expect(remembered(statementKey("s", "k1", f, 100))).toBeUndefined();
    expect(remembered(statementKey("s", "k1", { ...f, kind: "credit" }, 100))).toBeUndefined();
    expect(remembered(statementKey("s", "k2", f, 100))).toBe(3);
    forgetStatements("s", null);
    expect(remembered(statementKey("s", "k2", f, 100))).toBeUndefined();
  });
  it("demonstração: lança, estorna uma vez e recalcula o saldo", async () => {
    const data = {
      ...emptySnapshot,
      clients: [{ id: "cl", company_id: "co", name: "Vittalium", archived: false }],
      products: [{ id: "p", company_id: "co", name: "Make Ads", color: "#000" }],
      contracts: [
        { id: "k", company_id: "co", client_id: "cl", product_id: "p", name: "Make Ads", archived: false },
      ],
    } as unknown as typeof emptySnapshot;
    const media = demoMedia(() => data, "u");
    const before = (await media.accounts(false)).accounts[0].balance;
    const [deposit] = await media.categories();
    const id = await media.createEntry({
      contract: "k",
      kind: "credit",
      amount: 100,
      occurred_on: "2026-01-01",
      category: deposit.id,
      reason: "Pix",
    });
    expect((await media.accounts(false)).accounts[0].balance).toBeCloseTo(before + 100);
    await media.reverse(id, "Errado");
    await expect(media.reverse(id, "De novo")).rejects.toThrow(/já foi estornado/);
    expect((await media.accounts(false)).accounts[0].balance).toBeCloseTo(before);
    const s = await media.statement("k", { from: "", to: "", kind: "reversal", category: "" }, 100, 0);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].reversal_of).toBe(id);
  });
});
