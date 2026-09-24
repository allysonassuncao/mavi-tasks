import { describe, expect, it } from "vitest";
import { fetchAllRows, PAGE_ROWS } from "./api";

/** A table of `total` rows behind a PostgREST-like builder capped at max-rows. */
function fakeTable(
  total: number,
  failAt?: number,
  maxRows = PAGE_ROWS,
  withCount = true,
) {
  const calls: { from: number; to: number; count?: string }[] = [];
  const build = (count?: "exact") => ({
    range(from: number, to: number) {
      calls.push({ from, to, count });
      const end = Math.min(to, from + maxRows - 1, total - 1);
      const data = Array.from(
        { length: Math.max(0, end - from + 1) },
        (_, i) => from + i,
      );
      const result =
        failAt === from
          ? { data: null, error: new Error("falhou"), count: null }
          : {
              data,
              error: null,
              count: count && withCount ? total : null,
            };
      return Object.assign(Promise.resolve(result), {
        range: () => {
          throw Error("range chamado duas vezes");
        },
      });
    },
  });
  return { build: build as never, calls };
}

describe("fetchAllRows", () => {
  it("lê uma página só quando cabe no limite", async () => {
    const t = fakeTable(12);
    expect(await fetchAllRows<number>(t.build)).toHaveLength(12);
    expect(t.calls).toEqual([{ from: 0, to: PAGE_ROWS - 1, count: "exact" }]);
  });

  it("traz todas as linhas além de 1000, em ordem e sem repetir", async () => {
    const t = fakeTable(3500);
    const rows = await fetchAllRows<number>(t.build);
    expect(rows).toHaveLength(3500);
    expect(rows).toEqual(Array.from({ length: 3500 }, (_, i) => i));
    // Only the first page asks for the count.
    expect(t.calls.filter((c) => c.count)).toHaveLength(1);
    expect(t.calls.map((c) => c.from).sort((a, b) => a - b)).toEqual([
      0, 1000, 2000, 3000,
    ]);
  });

  it("funciona com exatamente 1000 linhas", async () => {
    const t = fakeTable(PAGE_ROWS);
    expect(await fetchAllRows<number>(t.build)).toHaveLength(PAGE_ROWS);
    expect(t.calls).toHaveLength(1);
  });

  it("traz tudo quando o projeto limita as páginas abaixo de 1000", async () => {
    // e.g. "Max rows" set to 100 in the API settings: 250 clients.
    const t = fakeTable(250, undefined, 100);
    const rows = await fetchAllRows<number>(t.build);
    expect(rows).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(t.calls.map((c) => [c.from, c.to])).toEqual([
      [0, PAGE_ROWS - 1],
      [100, 199],
      [200, 299],
    ]);
  });

  it("sem a contagem, lê até uma página vir incompleta", async () => {
    const t = fakeTable(2300, undefined, PAGE_ROWS, false);
    const rows = await fetchAllRows<number>(t.build);
    expect(rows).toEqual(Array.from({ length: 2300 }, (_, i) => i));
    expect(t.calls.map((c) => c.from)).toEqual([0, 1000, 2000]);
  });

  it("tabela vazia faz uma chamada só", async () => {
    const t = fakeTable(0);
    expect(await fetchAllRows<number>(t.build)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it("propaga o erro de qualquer página", async () => {
    const t = fakeTable(2500, 2000);
    await expect(fetchAllRows<number>(t.build)).rejects.toThrow("falhou");
  });
});
