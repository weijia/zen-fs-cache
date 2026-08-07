/**
 * A generic IndexedDB-backed key-value store for arbitrary
 * structured-clone-compatible values (strings, numbers, objects, arrays,
 * `Uint8Array`, `Map`, `Set`, etc.).
 *
 * Unlike {@link IdbCacheStore} (which stores `CacheValue` wrappers for the
 * `CachedFileSystem` layer), `IdbKVStore` is a lightweight primitive that
 * backend implementations can use to persist their *internal* caches
 * (e.g. SHA maps, mtime maps, ETag snapshots) across page reloads.
 *
 * Falls back to a no-op (all operations succeed but store nothing) when
 * IndexedDB is unavailable, e.g. in a Node.js test environment.
 *
 * ```ts
 * const store = new IdbKVStore('zen-fs-gitee:owner/repo', 'sha-cache');
 * await store.set('/path/to/file', 'abc123def456');
 * const sha = await store.get<string>('/path/to/file');
 * ```
 */
export class IdbKVStore {
	private dbPromise?: Promise<IDBDatabase>;
	private failed = false;

	/**
	 * @param dbName    IndexedDB database name. Use a unique name per
	 *                  backend/connection to avoid collisions.
	 * @param storeName Object store name within the database.
	 */
	constructor(
		private dbName = 'zen-fs-kv',
		private storeName = 'kv',
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

	/**
	 * Retrieve a value by key, or `undefined` if not found.
	 */
	async get<T>(key: string): Promise<T | undefined> {
		try {
			const db = await this.open();
			return await new Promise<T | undefined>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const req = tx.objectStore(this.storeName).get(key);
				req.onsuccess = () => resolve((req.result as T) ?? undefined);
				req.onerror = () => reject(req.error);
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Store a value under the given key. Overwrites existing entries.
	 */
	async set(key: string, value: unknown): Promise<void> {
		try {
			const db = await this.open();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				tx.objectStore(this.storeName).put(value, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {
			// best-effort persistence
		}
	}

	/**
	 * Delete a single key. No-op if the key does not exist.
	 */
	async delete(key: string): Promise<void> {
		try {
			const db = await this.open();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				tx.objectStore(this.storeName).delete(key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {
			// best-effort persistence
		}
	}

	/**
	 * Remove all entries from this object store.
	 */
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
			// best-effort persistence
		}
	}

	/**
	 * Return all keys in this store. Useful for bulk operations.
	 */
	async keys(): Promise<string[]> {
		try {
			const db = await this.open();
			return await new Promise<string[]>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const req = tx.objectStore(this.storeName).getAllKeys();
				req.onsuccess = () => resolve((req.result as string[]) ?? []);
				req.onerror = () => reject(req.error);
			});
		} catch {
			return [];
		}
	}

	/**
	 * Return all key-value pairs as an array of `[key, value]` tuples.
	 * Useful for bulk-loading an entire cache into memory on startup.
	 */
	async entries<T>(): Promise<[string, T][]> {
		try {
			const db = await this.open();
			return await new Promise<[string, T][]>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readonly');
				const store = tx.objectStore(this.storeName);
				const result: [string, T][] = [];
				const cursorReq = store.openCursor();
				cursorReq.onsuccess = () => {
					const cursor = cursorReq.result;
					if (cursor) {
						result.push([cursor.key as string, cursor.value as T]);
						cursor.continue();
					} else {
						resolve(result);
					}
				};
				cursorReq.onerror = () => reject(cursorReq.error);
			});
		} catch {
			return [];
		}
	}

	/**
	 * Bulk-set multiple key-value pairs in a single transaction.
	 * More efficient than calling `set()` in a loop.
	 */
	async setMany(entries: [string, unknown][]): Promise<void> {
		if (entries.length === 0) return;
		try {
			const db = await this.open();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(this.storeName, 'readwrite');
				const store = tx.objectStore(this.storeName);
				for (const [key, value] of entries) {
					store.put(value, key);
				}
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		} catch {
			// best-effort persistence
		}
	}
}

function idbAvailable(): boolean {
	try {
		return typeof indexedDB !== 'undefined' && indexedDB !== null;
	} catch {
		return false;
	}
}
