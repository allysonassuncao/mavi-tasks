import { describe, expect, it } from "vitest";
import {
  categoriesFor,
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
