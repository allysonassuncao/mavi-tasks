import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as cache from "./cache";
import { clearCompanyCaches, liveChangeConcerns, type LiveChange } from "./api";

const change = (users: string[], task = "t1") =>
  ({ kind: "task", op: "update", task, users }) as Extract<
    LiveChange,
    { task: string }
  >;
const who = (over: Partial<Parameters<typeof liveChangeConcerns>[1]> = {}) => ({
  user: "me",
  isLeader: false,
  supervisesTeam: false,
  onScreen: () => false,
  ...over,
});

describe("liveChangeConcerns", () => {
  it("avisa criador, responsável e participantes", () => {
    expect(liveChangeConcerns(change(["a", "me"]), who())).toBe(true);
  });
  it("ignora tarefas alheias de quem não lidera", () => {
    expect(liveChangeConcerns(change(["a", "b"]), who())).toBe(false);
  });
  it("líderes e supervisores recebem tudo", () => {
    expect(liveChangeConcerns(change(["a"]), who({ isLeader: true }))).toBe(
      true,
    );
    expect(
      liveChangeConcerns(change(["a"]), who({ supervisesTeam: true })),
    ).toBe(true);
  });
  it("tarefa na tela sempre atualiza", () => {
    expect(
      liveChangeConcerns(change(["a"]), who({ onScreen: (id) => id === "t1" })),
    ).toBe(true);
  });
});

class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.get(k) ?? null;
  }
  key(i: number) {
    return [...this.store.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
}
const localStorage = new MemoryStorage();

describe("cache só em memória", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorage;
    (globalThis as any).window = { localStorage };
    localStorage.clear();
    cache.clear();
  });
  afterEach(() => {
    cache.setMemoryOnly([]);
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
  });
  it("não grava nem lê do localStorage os prefixos de tarefa", () => {
    cache.setMemoryOnly(["tasks:"]);
    cache.set("tasks:c1:x", { n: 1 });
    cache.set("lookups:v3:c1", { n: 2 });
    const stored = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i),
    ) as string[];
    expect(stored.some((k) => k.includes("tasks:c1:x"))).toBe(false);
    expect(stored.some((k) => k.includes("lookups:v3:c1"))).toBe(true);
    expect(cache.get("tasks:c1:x")).toEqual({ n: 1 });
  });
  it("remove cópias antigas deixadas por versões anteriores", () => {
    cache.setMemoryOnly([]);
    cache.set("task:c1:old", { stale: true });
    cache.clear();
    localStorage.setItem(
      "mavi:cache:v1:task:c1:old",
      JSON.stringify({
        data: { stale: true },
        createdAt: 0,
        expiresAt: Date.now() + 1e6,
      }),
    );
    cache.setMemoryOnly(["task:"]);
    expect(localStorage.getItem("mavi:cache:v1:task:c1:old")).toBeNull();
    expect(cache.get("task:c1:old")).toBeNull();
  });
});

describe("Atualizar (clearCompanyCaches)", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = localStorage;
    (globalThis as any).window = { localStorage };
    localStorage.clear();
    cache.clear();
    cache.setMemoryOnly([]);
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
  });
  it("apaga da memória e do localStorage tudo da empresa, e só dela", () => {
    cache.set("lookups:v5:c1", { n: 1 });
    cache.set("tasks:c1:lista", { n: 2 });
    cache.set("task_extras:t1", { n: 3 });
    cache.set("companies", { n: 4 });
    cache.set("lookups:v5:c2", { n: 5 });
    clearCompanyCaches("c1");
    for (const key of [
      "lookups:v5:c1",
      "tasks:c1:lista",
      "task_extras:t1",
      "companies",
    ]) {
      expect(cache.get(key)).toBeNull();
      expect(localStorage.getItem(`mavi:cache:v1:${key}`)).toBeNull();
    }
    expect(cache.get("lookups:v5:c2")).toEqual({ n: 5 });
  });
});
