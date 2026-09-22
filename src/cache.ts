/**
 * Local cache manager with dual-layer storage (Memory + LocalStorage).
 *
 * Provides synchronous instant retrieval from RAM, persistence across reloads
 * via localStorage, TTL-based expiration, promise deduplication for concurrent
 * requests, and scoped invalidation.
 */

const STORAGE_PREFIX = "mavi:cache:v1:";

interface CacheRecord<T = unknown> {
  data: T;
  expiresAt: number;
  createdAt: number;
}

const memoryStore = new Map<string, CacheRecord>();
const inFlightRequests = new Map<string, Promise<unknown>>();

function getStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== "undefined" && (globalThis as any).localStorage) {
      return (globalThis as any).localStorage as Storage;
    }
    return null;
  } catch {
    return null;
  }
}

function readFromStorage<T>(key: string): CacheRecord<T> | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const record = JSON.parse(raw) as CacheRecord<T>;
    if (!record || typeof record.expiresAt !== "number") {
      storage.removeItem(STORAGE_PREFIX + key);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeToStorage<T>(key: string, record: CacheRecord<T>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
  } catch {
    // If storage is full, evict expired items first.
    try {
      evictExpired();
      storage.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
    } catch {
      // Storage quota reached or denied; in-memory cache will still serve the app.
    }
  }
}

function removeFromStorage(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Remove all expired records from storage and memory.
 */
export function evictExpired(): void {
  const now = Date.now();
  for (const [key, record] of memoryStore.entries()) {
    if (record.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }

  const storage = getStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        try {
          const raw = storage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw) as CacheRecord;
            if (parsed.expiresAt <= now) {
              keysToRemove.push(key);
            }
          }
        } catch {
          keysToRemove.push(key);
        }
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage iteration errors.
  }
}

/**
 * Get an item from cache if it exists and has not expired.
 */
export function get<T>(key: string): T | null {
  const now = Date.now();

  // 1. Check in-memory store
  const memRecord = memoryStore.get(key) as CacheRecord<T> | undefined;
  if (memRecord) {
    if (memRecord.expiresAt > now) {
      return memRecord.data;
    }
    memoryStore.delete(key);
    removeFromStorage(key);
    return null;
  }

  // 2. Check localStorage
  const storedRecord = readFromStorage<T>(key);
  if (storedRecord) {
    if (storedRecord.expiresAt > now) {
      memoryStore.set(key, storedRecord);
      return storedRecord.data;
    }
    removeFromStorage(key);
    return null;
  }

  return null;
}

/**
 * Save an item to cache with a Time-To-Live in milliseconds.
 * Default TTL: 10 minutes.
 */
export function set<T>(key: string, data: T, ttlMs = 10 * 60 * 1000): void {
  const now = Date.now();
  const record: CacheRecord<T> = {
    data,
    createdAt: now,
    expiresAt: now + ttlMs,
  };

  memoryStore.set(key, record);
  writeToStorage(key, record);
}

/**
 * Remove a specific key from cache.
 */
export function remove(key: string): void {
  memoryStore.delete(key);
  removeFromStorage(key);
}

/**
 * Update an existing cached item in-place (both in memory and storage).
 * If updater returns null, the item is removed.
 */
export function update<T>(
  key: string,
  updater: (current: T | null) => T | null,
  ttlMs = 10 * 60 * 1000,
): void {
  const current = get<T>(key);
  const updated = updater(current);
  if (updated === null) {
    remove(key);
  } else {
    set(key, updated, ttlMs);
  }
}

/**
 * Update all cached items matching a prefix or predicate in-place.
 */
export function updateMatching<T>(
  predicateOrPrefix: string | ((key: string) => boolean),
  updater: (key: string, current: T) => T | null,
): void {
  const predicate =
    typeof predicateOrPrefix === "string"
      ? (k: string) => k.startsWith(predicateOrPrefix)
      : predicateOrPrefix;

  const matchedKeys = new Set<string>();
  for (const key of memoryStore.keys()) {
    if (predicate(key)) matchedKeys.add(key);
  }

  const storage = getStorage();
  if (storage) {
    for (let i = 0; i < storage.length; i++) {
      const storageKey = storage.key(i);
      if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
        const localKey = storageKey.slice(STORAGE_PREFIX.length);
        if (predicate(localKey)) matchedKeys.add(localKey);
      }
    }
  }

  for (const key of matchedKeys) {
    const current = get<T>(key);
    if (current !== null) {
      const updated = updater(key, current);
      if (updated === null) {
        remove(key);
      } else {
        const memRecord = memoryStore.get(key);
        const remainingTtl = memRecord
          ? Math.max(1000, memRecord.expiresAt - Date.now())
          : 10 * 60 * 1000;
        set(key, updated, remainingTtl);
      }
    }
  }
}

/**
 * Invalidate all keys matching a prefix or a predicate function.
 */
export function invalidate(
  predicateOrPrefix: string | ((key: string) => boolean),
): void {
  const predicate =
    typeof predicateOrPrefix === "string"
      ? (k: string) => k.startsWith(predicateOrPrefix)
      : predicateOrPrefix;

  // Clear memory
  for (const key of memoryStore.keys()) {
    if (predicate(key)) {
      memoryStore.delete(key);
    }
  }

  // Clear localStorage
  const storage = getStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const storageKey = storage.key(i);
      if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
        const localKey = storageKey.slice(STORAGE_PREFIX.length);
        if (predicate(localKey)) {
          keysToRemove.push(storageKey);
        }
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}

/**
 * Clear all cache entries created by this application.
 */
export function clear(): void {
  memoryStore.clear();
  inFlightRequests.clear();

  const storage = getStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const storageKey = storage.key(i);
      if (storageKey && storageKey.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(storageKey);
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // Ignore storage errors.
  }
}

export interface FetchWithCacheOptions {
  ttlMs?: number;
  forceRefresh?: boolean;
}

/**
 * Fetch data with caching and concurrent request deduplication.
 * If data is already cached and valid, returns it immediately without calling fetcher.
 * If multiple callers request the same key concurrently, only one network request runs.
 */
export async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: FetchWithCacheOptions = {},
): Promise<T> {
  const { ttlMs = 10 * 60 * 1000, forceRefresh = false } = options;

  if (!forceRefresh) {
    const cached = get<T>(key);
    if (cached !== null) {
      return cached;
    }
  }

  // Request deduplication: check if already in flight
  const existing = inFlightRequests.get(key) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    try {
      const data = await fetcher();
      set<T>(key, data, ttlMs);
      return data;
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return promise;
}
