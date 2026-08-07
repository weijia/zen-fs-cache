/**
 * zen-fs-cache
 *
 * A generic caching layer for any zen-fs compatible filesystem. Wrap a backend
 * (e.g. `zen-fs-remotestoragejs`) with {@link CachedFileSystem} and give it a
 * {@link CacheStore} to get HTTP-style revalidation (ETag / Last-Modified /
 * 304) plus pluggable persistence (memory / IndexedDB).
 *
 * ```ts
 * import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';
 * import { CachedFileSystem, IdbCacheStore } from 'zen-fs-cache';
 *
 * const fs = new CachedFileSystem(
 *   new RemoteStorageFileSystem({ href, token }),
 *   new IdbCacheStore('myapp:'),
 * );
 * ```
 */

export { CachedFileSystem } from './cached-file-system.js';
export type { CachedFileSystemOptions } from './cached-file-system.js';

export { MemoryCacheStore, IdbCacheStore, createDefaultCache } from './cache-store.js';
export { IdbKVStore } from './idb-kv-store.js';

export type {
  CacheStore,
  CacheValue,
  CacheableFileSystem,
  ReadFileMetaResult,
} from './types.js';
