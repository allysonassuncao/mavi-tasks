import { describe, expect, it } from "vitest";
import { fetchAllRows, PAGE_ROWS } from "./api";

/** A table of `total` rows behind a PostgREST-like builder capped at max-rows. */
function fakeTable(total: number, failAt?: number) {
  const calls: { from: number; to: number; count?: string }[] = [];
  const build = (count?: "exact") => ({
    range(from: number, to: number) {
      calls.push({ from, to, count });
      const end = Math.min(to, from + PAGE_ROWS - 1, total - 1);
      const data = Array.from(
        { length: Math.max(0, end - from + 1) },
        (_, i) => from + i,
      );
      const result =
        failAt === from
          ? { data: null, error: new Error("falhou"), count: null }
          : { data, error: null, count: count ? total : null };
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

  it("propaga o erro de qualquer página", async () => {
    const t = fakeTable(2500, 2000);
    await expect(fetchAllRows<number>(t.build)).rejects.toThrow("falhou");
  });
});
