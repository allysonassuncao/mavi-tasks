import { describe, expect, it } from "vitest";
import { pageWindow } from "./Pagination";

describe("pageWindow", () => {
  it("mostra todas as páginas quando são poucas", () => {
    expect(pageWindow(0, 5)).toEqual([0, 1, 2, 3, 4]);
  });
  it("resume o meio com reticências", () => {
    expect(pageWindow(20, 54)).toEqual([0, "gap", 19, 20, 21, "gap", 53]);
  });
  it("perto do início, mostra as primeiras páginas", () => {
    expect(pageWindow(1, 54)).toEqual([0, 1, 2, 3, 4, "gap", 53]);
  });
  it("perto do fim, mostra as últimas páginas", () => {
    expect(pageWindow(53, 54)).toEqual([0, "gap", 49, 50, 51, 52, 53]);
  });
  it("sempre inclui a página atual e nunca repete", () => {
    for (let total = 1; total < 40; total++)
      for (let page = 0; page < total; page++) {
        const nums = pageWindow(page, total).filter((p) => p !== "gap");
        expect(nums).toContain(page);
        expect(new Set(nums).size).toBe(nums.length);
        expect(nums[0]).toBe(0);
        expect(nums.at(-1)).toBe(total - 1);
      }
  });
});
