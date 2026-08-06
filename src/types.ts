/**
 * Result of a freshness-aware read. Returned by a backend that implements
 * {@link CacheableFileSystem.readFileMeta}. The cache uses it to avoid
 * re-downloading unchanged content (HTTP `304` semantics).
 */
export interface ReadFileMetaResult {
  /** HTTP status: `200` when fresh bytes are returned, `304` when unchanged. */
  status: number;
  /** Present only when `status === 200`. */
  data?: Uint8Array;
  /** Entity tag (`ETag`) returned by the server, if any. */
  etag?: string;
  /** HTTP-date from the `Last-Modified` header, if any. */
  lastModified?: string;
  /** MIME type of the payload. */
  contentType?: string;
}

/**
 * A zen-fs compatible filesystem that optionally exposes revalidation hooks so
 * a generic cache ({@link CachedFileSystem}) can manage it without knowing
 * anything about the underlying transport.
 *
 * This is a *structural* interface: any object providing these methods
 * (including a `@zenfs/core` `FileSystem` subclass) is accepted.
 *
 * ## Revalidation strategy
 *
 * The cache picks the most efficient available strategy on each read:
 *
 * 1. **`getRevision` (preferred when present)** — The cache calls
 *    `getRevision(path)` and compares the returned token against the one
 *    stored with the cached entry. If they match, the cached value is returned
 *    with **zero content download**. This is a single lightweight request
 *    (e.g. an HTTP `HEAD` for ETag, or an in-memory Git blob SHA lookup).
 *
 * 2. **`readFileMeta` (HTTP conditional GET)** — If `getRevision` is not
 *    implemented but `readFileMeta` is, the cache sends a conditional request
 *    (`If-None-Match` / `If-Modified-Since`). A `304` response means the
 *    content is unchanged — the cached body is returned without downloading.
 *
 * 3. **TTL (fallback)** — If neither hook is implemented, or `getRevision`
 *    returns `undefined`, the cache falls back to a time-based TTL. Within
 *    `ttlMs` the cached value is returned without any network access.
 *
 * ## Write strategy
 *
 * - If `getRevision` is implemented: after `writeFile`, the cache **updates**
 *   the cached entry with the new content and a fresh revision token, rather
 *   than deleting it. This avoids a redundant re-download on the next read.
 * - If `getRevision` is not implemented: the cache **invalidates** (deletes)
 *   the affected entries, so the next read re-fetches from the backend.
 */
export interface CacheableFileSystem {
  // --- Required filesystem methods (delegated by the cache) ---

  readFile(path: string, ...args: any[]): Promise<Uint8Array>;
  writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: { flag?: string; [k: string]: unknown },
  ): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string, ...args: any[]): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;

  // --- Optional revalidation hooks ---

  /**
   * Return an opaque revision token for any path (file or directory).
   *
   * The token **must change whenever the content changes**, and **must remain
   * stable when the content is unchanged**. The cache stores this token
   * alongside the cached content; on subsequent reads it calls `getRevision`
   * again and compares the two tokens — if they match, the cached content is
   * returned without any download.
   *
   * This is the **preferred revalidation mechanism** because:
   * - It is a single round-trip (vs. `readFileMeta` which downloads the body
   *   on `200`).
   * - For some backends it is **zero round-trips** — e.g. `GiteeFS` and
   *   `GitHubFS` cache Git blob SHAs in memory at init time (populated from
   *   a single `getTree` API call), so `getRevision` is a pure `Map.get()`
   *   with no network access at all.
   *
   * ## What to return
   *
   * | Backend type | Typical revision token | Source |
   * |---|---|---|
   * | HTTP (RemoteStorage) | `ETag` header value | `HEAD` request → `response.headers.get('ETag')` |
   * | HTTP (no ETag) | `Last-Modified` header value | `HEAD` request → `response.headers.get('Last-Modified')` |
   * | Git (Gitee/GitHub) | Git blob SHA (40-char hex) | In-memory `shaCache.get(path)` — **no network access** |
   * | Local FS | `mtimeMs` | `stat(path).mtimeMs` |
   * | Content-addressable | Content hash | `sha256(content)` |
   *
   * ## When to return `undefined`
   *
   * - The path does not exist (file was deleted or never created)
   * - The backend cannot determine a revision (e.g. network error, HEAD
   *   request returned non-200)
   *
   * Returning `undefined` causes the cache to fall through to the next
   * revalidation strategy (`readFileMeta` → TTL → full read).
   *
   * ## Directory revisions
   *
   * For `readdir` / `stat` revalidation, `getRevision` is called on the
   * directory path. The token should change when the directory's listing
   * changes (files added/removed/renamed). For Git backends, there is no
   * directory-level SHA — return `undefined` to let the cache re-read the
   * directory listing. For HTTP backends, the ETag of the directory document
   * works.
   *
   * ## Local caching
   *
   * Backends are encouraged to **cache the revision locally** so that
   * `getRevision` does not always require a network request. For example:
   *
   * - `GiteeFS` / `GitHubFS`: The `shaCache` (`Map<path, blobSHA>`) is
   *   populated during `init()` from a single `getTree` API call and updated
   *   on every `writeFile` / `unlink` from the API response. Subsequent
   *   `getRevision` calls are pure memory lookups.
   *
   * - `RemoteStorageFileSystem`: No local cache — each `getRevision` sends a
   *   `HEAD` request. The returned ETag is stored in the `CachedFileSystem`'s
   *   `CacheStore` (IndexedDB), so the *comparison* is local, but fetching
   *   the *current* ETag requires one network round-trip.
   *
   * @param path - File or directory path (always absolute, starting with `/`)
   * @returns Revision token, or `undefined` if not available
   */
  getRevision?(path: string): Promise<string | number | undefined>;

  /**
   * Read a file together with freshness metadata, supporting conditional
   * requests so the cache can avoid re-downloading unchanged content.
   *
   * Used as a fallback when `getRevision` is not implemented or returns
   * `undefined`. Implementations must honour `If-None-Match` /
   * `If-Modified-Since` and return `304` (with no body) when the content is
   * unchanged.
   *
   * ## When to implement
   *
   * Only implement this if the backend's HTTP API supports conditional GET
   * (i.e. the server honours `If-None-Match` / `If-Modified-Since` headers
   * and returns `304`). If the API does not support conditional GET (e.g.
   * Gitee's REST API), implement `getRevision` instead — it is simpler and
   * more efficient.
   *
   * ## `readFileMeta` vs `getRevision`
   *
   * | | `getRevision` | `readFileMeta` |
   * |---|---|---|
   * | Network requests per read (unchanged) | 1 (or 0 for Git) | 1 (conditional GET → 304) |
   * | Network requests per read (changed) | 1 (rev check) + 1 (full read) | 1 (conditional GET → 200 + body) |
   * | Downloads body on unchanged? | No | No (304) |
   * | Needs HTTP conditional GET support? | No | Yes |
   * | Works for readdir/stat? | Yes | No (file only) |
   *
   * If both are implemented, `getRevision` takes priority.
   */
  readFileMeta?(
    path: string,
    opts?: { ifNoneMatch?: string; ifModifiedSince?: string },
  ): Promise<ReadFileMetaResult>;

  /** Optional byte-level read (delegated when present). */
  read?(path: string, buffer: Uint8Array, start: number, end: number): Promise<void>;

  /** Optional byte-level write (delegated when present). */
  write?(path: string, buffer: Uint8Array, offset: number): Promise<void>;
}

/** A single cached payload plus the validators used for re-validation. */
export interface CacheValue {
  /** Raw cached body (file bytes, or JSON-encoded directory listing / inode). */
  value: Uint8Array;
  /** Entity tag for conditional `GET` (if known). */
  etag?: string;
  /** HTTP-date for conditional `GET` (if known). */
  lastModified?: string;
  /**
   * Generic revision token for cheap revalidation (ETag / mtimeMs / blob SHA / hash).
   *
   * Populated from `getRevision()` or from `readFileMeta()`'s `etag` /
   * `lastModified`. Used to compare against the backend's current revision
   * on subsequent reads — if they match, the cached `value` is returned
   * without downloading.
   */
  revision?: string | number;
  /** MIME type of the stored payload. */
  contentType?: string;
  /** Epoch ms when this entry was stored/refreshed. */
  cachedAt: number;
}

/**
 * Pluggable storage backend for cache entries. Implementations must be safe to
 * call from async contexts.
 *
 * Two implementations are provided:
 * - {@link MemoryCacheStore} — in-memory `Map`, session-scoped
 * - {@link IdbCacheStore} — IndexedDB, persists across page reloads
 */
export interface CacheStore {
  get(key: string): Promise<CacheValue | undefined>;
  set(key: string, value: CacheValue): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
