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
 * (including a `@zenfs/core` `FileSystem` subclass) is accepted. Only the two
 * optional hooks below (`readFileMeta` / `getRevision`) need to be implemented
 * by a backend that wants efficient, timestamp-based caching. Backends that
 * don't implement them still get basic TTL caching.
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

  // --- Optional revalidation hooks (enable timestamp-based caching) ---

  /**
   * Read a file together with freshness metadata, supporting conditional
   * requests so the cache can avoid re-downloading unchanged content.
   *
   * Implementations must honour `If-None-Match` / `If-Modified-Since` and
   * return `304` (with no body) when the content is unchanged.
   */
  readFileMeta?(
    path: string,
    opts?: { ifNoneMatch?: string; ifModifiedSince?: string },
  ): Promise<ReadFileMetaResult>;

  /**
   * Return an opaque revision token for any path (file or directory). The
   * token must change whenever the content changes. Typical values:
   * `ETag` for remote backends, `mtimeMs` for local backends, a content hash,
   * etc. Used for cheap revalidation of `readdir` / `stat` and as a fallback
   * for `readFile`.
   */
  getRevision?(path: string): Promise<string | number | undefined>;

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
  /** Generic revision token for cheap revalidation (ETag / mtimeMs / hash). */
  revision?: string | number;
  /** MIME type of the stored payload. */
  contentType?: string;
  /** Epoch ms when this entry was stored/refreshed. */
  cachedAt: number;
}

/**
 * Pluggable storage backend for cache entries. Implementations must be safe to
 * call from async contexts.
 */
export interface CacheStore {
  get(key: string): Promise<CacheValue | undefined>;
  set(key: string, value: CacheValue): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
