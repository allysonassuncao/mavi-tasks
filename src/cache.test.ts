import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as cache from "./cache";

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("cache module", () => {
  const mockStorage = new MockStorage();

  beforeEach(() => {
    (globalThis as any).localStorage = mockStorage;
    (globalThis as any).window = { localStorage: mockStorage };
    mockStorage.clear();
    cache.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
  });

  it("stores and retrieves data from memory and localStorage", () => {
    cache.set("test-key", { hello: "world" }, 60000);
    const result = cache.get<{ hello: string }>("test-key");
    expect(result).toEqual({ hello: "world" });

    // Verify it was persisted to storage
    expect(mockStorage.getItem("mavi:cache:v1:test-key")).toContain("world");
  });

  it("restores from localStorage when not in memory", () => {
    mockStorage.setItem(
      "mavi:cache:v1:stored-key",
      JSON.stringify({
        data: { fromStorage: true },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      }),
    );

    const result = cache.get<{ fromStorage: boolean }>("stored-key");
    expect(result).toEqual({ fromStorage: true });
  });

  it("returns null for non-existent key", () => {
    expect(cache.get("non-existent")).toBeNull();
  });

  it("respects TTL expiration", () => {
    const now = 1000000;
    vi.spyOn(Date, "now").mockReturnValue(now);

    cache.set("ttl-key", "value", 1000); // expires at 1001000
    expect(cache.get("ttl-key")).toBe("value");

    // Advance time past expiration
    vi.spyOn(Date, "now").mockReturnValue(now + 1500);
    expect(cache.get("ttl-key")).toBeNull();
  });

  it("removes specific key", () => {
    cache.set("remove-me", 42, 60000);
    expect(cache.get("remove-me")).toBe(42);
    cache.remove("remove-me");
    expect(cache.get("remove-me")).toBeNull();
  });

  it("invalidates keys by prefix", () => {
    cache.set("company:123:tasks", ["t1"], 60000);
    cache.set("company:123:clients", ["c1"], 60000);
    cache.set("company:456:tasks", ["t2"], 60000);

    cache.invalidate("company:123:");

    expect(cache.get("company:123:tasks")).toBeNull();
    expect(cache.get("company:123:clients")).toBeNull();
    expect(cache.get("company:456:tasks")).toEqual(["t2"]);
  });

  it("deduplicates concurrent fetches", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { count: callCount };
    };

    const [res1, res2, res3] = await Promise.all([
      cache.fetchWithCache("dedup-key", fetcher, { ttlMs: 60000 }),
      cache.fetchWithCache("dedup-key", fetcher, { ttlMs: 60000 }),
      cache.fetchWithCache("dedup-key", fetcher, { ttlMs: 60000 }),
    ]);

    expect(callCount).toBe(1);
    expect(res1).toEqual({ count: 1 });
    expect(res2).toEqual({ count: 1 });
    expect(res3).toEqual({ count: 1 });
  });

  it("serves from cache on second call to fetchWithCache without calling fetcher", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return "fresh";
    };

    const first = await cache.fetchWithCache("cached-fetch", fetcher, {
      ttlMs: 60000,
    });
    expect(first).toBe("fresh");
    expect(callCount).toBe(1);

    const second = await cache.fetchWithCache("cached-fetch", fetcher, {
      ttlMs: 60000,
    });
    expect(second).toBe("fresh");
    expect(callCount).toBe(1);
  });

  it("forces refresh when forceRefresh is true", async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return `result-${callCount}`;
    };

    await cache.fetchWithCache("force-key", fetcher, { ttlMs: 60000 });
    expect(callCount).toBe(1);

    const refreshed = await cache.fetchWithCache("force-key", fetcher, {
      ttlMs: 60000,
      forceRefresh: true,
    });
    expect(callCount).toBe(2);
    expect(refreshed).toBe("result-2");
  });

  it("updates cached item in place with update()", () => {
    cache.set("item-1", { count: 1 }, 60000);
    cache.update<{ count: number }>("item-1", (curr) => ({
      count: (curr?.count ?? 0) + 1,
    }));

    expect(cache.get<{ count: number }>("item-1")).toEqual({ count: 2 });
  });

  it("updates all matching cached items with updateMatching()", () => {
    cache.set("tasks:c1:p0", [{ id: "t1", title: "Original" }], 60000);
    cache.set(
      "tasks:c1:p1",
      [
        { id: "t1", title: "Original" },
        { id: "t2", title: "T2" },
      ],
      60000,
    );
    cache.set("tasks:c2:p0", [{ id: "t1", title: "Original" }], 60000);

    cache.updateMatching<{ id: string; title: string }[]>(
      "tasks:c1:",
      (_k, tasks) => {
        return tasks.map((t) =>
          t.id === "t1" ? { ...t, title: "Updated" } : t,
        );
      },
    );

    expect(cache.get<{ id: string; title: string }[]>("tasks:c1:p0")).toEqual([
      { id: "t1", title: "Updated" },
    ]);
    expect(cache.get<{ id: string; title: string }[]>("tasks:c1:p1")).toEqual([
      { id: "t1", title: "Updated" },
      { id: "t2", title: "T2" },
    ]);
    // c2 was unaffected
    expect(cache.get<{ id: string; title: string }[]>("tasks:c2:p0")).toEqual([
      { id: "t1", title: "Original" },
    ]);
  });
});
