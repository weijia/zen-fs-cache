import type { CacheStore, CacheValue } from './types.js';

/**
 * Default in-memory cache. Enabled automatically unless a custom `CacheStore`
 * is provided. Lives for the lifetime of the filesystem instance (typically
 * the page session).
 */
export class MemoryCacheStore implements CacheStore {
  private store = new Map<string, CacheValue>();

  async get(key: string): Promise<CacheValue | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: CacheValue): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/**
 * Persistent cache backed by the browser's IndexedDB. Values (including
 * `Uint8Array` bodies) are stored via structured clone, so they survive page
 * reloads and are not subject to `localStorage`'s ~5MB / string-only limits.
 *
 * Falls back to a no-op (cache misses) when `IndexedDB` is unavailable, e.g.
 * in a Node.js test environment.
 *
 * ```ts
 * const fs = new CachedFileSystem(
 *   new RemoteStorageFileSystem({ href, token }),
 *   new IdbCacheStore('myapp:'),
 * );
 * ```
 */
export class IdbCacheStore implements CacheStore {
  private dbPromise?: Promise<IDBDatabase>;
  private failed = false;

  constructor(
    private prefix = 'zen-fs-cache:',
    private dbName = 'zen-fs-cache',
    private storeName = 'cache',
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.failed) return Promise.reject(new Error('IndexedDB unavailable'));
    if (this.dbPromise) return this.dbPromise;
    if (!idbAvailable()) {
      this.failed = true;
      return Promise.reject(new Error('IndexedDB unavailable'));
    }
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private key(k: string): string {
    return this.prefix + k;
  }

  async get(key: string): Promise<CacheValue | undefined> {
    try {
      const db = await this.open();
      return await new Promise<CacheValue | undefined>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).get(this.key(key));
        req.onsuccess = () => resolve((req.result as CacheValue) ?? undefined);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: CacheValue): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(value, this.key(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // best-effort cache
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(this.key(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // best-effort cache
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // best-effort cache
    }
  }
}

/** Create the default cache instance (in-memory). */
export function createDefaultCache(): CacheStore {
  return new MemoryCacheStore();
}
