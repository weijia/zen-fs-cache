import type { CacheableFileSystem, CacheStore } from './types.js';

function strToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToStr(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

/** Options for {@link CachedFileSystem}. */
export interface CachedFileSystemOptions {
  /**
   * Optimistic time-to-live in milliseconds. While an entry is younger than
   * this, reads are served directly from the cache *without* hitting the
   * network at all. Set to `0` (default) to always re-validate with the
   * backend via `getRevision` (or `readFileMeta`).
   *
   * Ignored when `getRevision` is implemented — the revision check is exact,
   * so there is no need for a TTL.
   */
  ttlMs?: number;
}

/**
 * A generic caching wrapper for any zen-fs compatible filesystem.
 *
 * - It implements the same subset of filesystem methods as the inner backend,
 *   so it is a drop-in replacement (including for `universal-sync-v2`'s
 *   `IFileSystem`).
 * - Reads go through the cache store. When the backend implements
 *   `getRevision`, it is used as the preferred revalidation mechanism (a
 *   single lightweight request — or zero for Git backends). Otherwise
 *   `readFileMeta` (HTTP conditional GET / 304) is used. If neither hook
 *   is available, a TTL-based fallback returns the cached value.
 * - Mutating operations (`writeFile` / `unlink` / `mkdir` / `rmdir` / `rename`)
 *   either **update** or **invalidate** the affected cache entries depending
 *   on whether `getRevision` is implemented.
 * - On network failure (non-404), the last known-good cached value is
 *   returned as a fallback (except for a `404`, which is always re-thrown so
 *   deletions are noticed).
 *
 * Because only the *interface* is required, any backend that implements the
 * optional hooks gets caching for free — there is no per-backend cache code.
 */
export class CachedFileSystem {
  private inner: CacheableFileSystem;
  private store: CacheStore;
  private ttlMs: number;

  constructor(
    inner: CacheableFileSystem,
    store: CacheStore,
    options: CachedFileSystemOptions = {},
  ) {
    this.inner = inner;
    this.store = store;
    this.ttlMs = options.ttlMs ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  /**
   * Invalidate all cache entries (file, dir, stat) for the given paths,
   * plus the parent directory of each path.
   */
  private async invalidate(...paths: string[]): Promise<void> {
    const keys: string[] = [];
    for (const p of paths) {
      const np = p.startsWith('/') ? p : `/${p}`;
      keys.push(`file:${np}`, `dir:${np}`, `stat:${np}`);
      const slash = np.lastIndexOf('/');
      const parent = slash > 0 ? np.slice(0, slash) : '';
      if (parent) keys.push(`dir:${parent}`);
    }
    for (const k of keys) {
      try {
        await this.store.delete(k);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Invalidate only stat and parent-dir entries (not the file content cache).
   * Used after `writeFile` when the file cache is updated in-place — the stat
   * must still be invalidated because size/mtime changed, and the parent dir
   * listing may have changed (new file).
   */
  private async invalidateMeta(...paths: string[]): Promise<void> {
    const keys: string[] = [];
    for (const p of paths) {
      const np = p.startsWith('/') ? p : `/${p}`;
      keys.push(`stat:${np}`);
      const slash = np.lastIndexOf('/');
      const parent = slash > 0 ? np.slice(0, slash) : '';
      if (parent) keys.push(`dir:${parent}`);
    }
    for (const k of keys) {
      try {
        await this.store.delete(k);
      } catch {
        // best-effort
      }
    }
  }

  private isNotFound(err: unknown): boolean {
    return (
      !!err &&
      ((err as { status?: number }).status === 404 ||
        (err as { code?: string }).code === 'ENOENT')
    );
  }

  /** Convert any supported write data type to `Uint8Array`. */
  private toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new TextEncoder().encode(data);
  }

  // ---------------------------------------------------------------------------
  // Reads (cached)
  // ---------------------------------------------------------------------------

  async readFile(path: string): Promise<Uint8Array> {
    const key = `file:${path}`;
    const cached = await this.store.get(key);

    // 1. TTL fast path — return cached value without any network access.
    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return cached.value;
    }

    // 2. getRevision — preferred revalidation mechanism.
    if (typeof this.inner.getRevision === 'function') {
      try {
        const rev = await this.inner.getRevision(path);
        if (rev != null) {
          // Revision available — compare with cached value.
          if (cached && rev === cached.revision) {
            return cached.value; // cache hit — zero content download
          }
          // Revision differs (or no cached value) — re-read and update cache.
          try {
            const data = await this.inner.readFile(path);
            await this.store.set(key, {
              value: data,
              revision: rev,
              cachedAt: Date.now(),
            });
            return data;
          } catch (err) {
            if (cached && !this.isNotFound(err)) return cached.value; // offline fallback
            throw err;
          }
        }
        // rev === undefined → fall through to readFileMeta
      } catch {
        // getRevision itself failed → fall through to readFileMeta
      }
    }

    // 3. readFileMeta — HTTP conditional GET fallback.
    if (typeof this.inner.readFileMeta === 'function') {
      try {
        const res = await this.inner.readFileMeta(path, {
          ifNoneMatch: cached?.etag,
          ifModifiedSince: cached?.etag ? undefined : cached?.lastModified,
        });
        if (res.status === 304 && cached) return cached.value;
        if (res.status === 200 && res.data) {
          await this.store.set(key, {
            value: res.data,
            etag: res.etag,
            lastModified: res.lastModified,
            revision: res.etag ?? res.lastModified,
            contentType: res.contentType,
            cachedAt: Date.now(),
          });
          return res.data;
        }
      } catch (err) {
        if (cached && !this.isNotFound(err)) return cached.value; // offline fallback
        throw err;
      }
    }

    // 4. Full read — no hooks available, or hooks returned undefined.
    const data = await this.inner.readFile(path);
    await this.store.set(key, {
      value: data,
      cachedAt: Date.now(),
    });
    return data;
  }

  async readdir(path: string): Promise<string[]> {
    const key = `dir:${path}`;
    const cached = await this.store.get(key);

    // 1. TTL fast path
    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return JSON.parse(bytesToStr(cached.value)) as string[];
    }

    // 2. getRevision
    if (typeof this.inner.getRevision === 'function') {
      try {
        const rev = await this.inner.getRevision(path);
        if (cached && rev != null && rev === cached.revision) {
          return JSON.parse(bytesToStr(cached.value)) as string[];
        }
      } catch {
        // ignore
      }
    }

    // 3. Full read
    const items = await this.inner.readdir(path);

    // Store with revision token for future revalidation
    let rev: string | number | undefined;
    if (typeof this.inner.getRevision === 'function') {
      try {
        rev = await this.inner.getRevision(path);
      } catch {
        // ignore
      }
    }

    await this.store.set(key, {
      value: strToBytes(JSON.stringify(items)),
      revision: rev,
      cachedAt: Date.now(),
    });
    return items;
  }

  async stat(path: string): Promise<Awaited<ReturnType<CacheableFileSystem['stat']>>> {
    const key = `stat:${path}`;
    const cached = await this.store.get(key);

    // 1. TTL fast path
    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return JSON.parse(bytesToStr(cached.value));
    }

    // 2. getRevision
    if (typeof this.inner.getRevision === 'function') {
      try {
        const rev = await this.inner.getRevision(path);
        if (cached && rev != null && rev === cached.revision) {
          return JSON.parse(bytesToStr(cached.value));
        }
      } catch {
        // ignore
      }
    }

    // 3. Full read
    const st = await this.inner.stat(path);

    // Store with revision token for future revalidation
    let rev: string | number | undefined;
    if (typeof this.inner.getRevision === 'function') {
      try {
        rev = await this.inner.getRevision(path);
      } catch {
        // ignore
      }
    }

    await this.store.set(key, {
      value: strToBytes(JSON.stringify(st)),
      revision: rev,
      cachedAt: Date.now(),
    });
    return st;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const innerType = this.inner?.constructor?.name ?? typeof this.inner;
      const hasStat = typeof this.inner?.stat === 'function';
      const hasExists = typeof this.inner?.exists === 'function';
      console.log(`[CACHE-TRACE] exists(${path}): inner type=${innerType} hasStat=${hasStat} hasExists=${hasExists}`);
      // Call inner.exists() if available — it may be cheaper than stat()
      // (e.g. RemoteStorageFileSystem.exists() checks existenceCache first)
      if (hasExists) {
        console.log(`[CACHE-TRACE] exists(${path}): calling inner.exists()`);
        const result = await this.inner.exists(path);
        console.log(`[CACHE-TRACE] exists(${path}): inner.exists() → ${result}`);
        return result;
      }
      console.log(`[CACHE-TRACE] exists(${path}): no inner.exists(), falling back to inner.stat()`);
      await this.inner.stat(path);
      console.log(`[CACHE-TRACE] exists(${path}): inner.stat() → OK (exists)`);
      return true;
    } catch (err) {
      if (this.isNotFound(err)) {
        console.log(`[CACHE-TRACE] exists(${path}): inner.stat() → NotFound`);
        return false;
      }
      console.log(`[CACHE-TRACE] exists(${path}): inner.stat() → ERROR: ${err}`);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Writes / mutations
  // ---------------------------------------------------------------------------

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: { flag?: string },
  ): Promise<void> {
    await this.inner.writeFile(path, data, options);

    if (typeof this.inner.getRevision === 'function') {
      // Update the file cache with the new content + a fresh revision token.
      // This avoids a redundant re-download on the next read.
      const bytes = this.toBytes(data);
      try {
        const rev = await this.inner.getRevision(path);
        await this.store.set(`file:${path}`, {
          value: bytes,
          revision: rev,
          cachedAt: Date.now(),
        });
      } catch {
        // If getRevision fails, fall back to invalidating the file cache.
        try {
          await this.store.delete(`file:${path}`);
        } catch {
          // best-effort
        }
      }
    } else {
      // No getRevision — invalidate the file cache so the next read re-fetches.
      try {
        await this.store.delete(`file:${path}`);
      } catch {
        // best-effort
      }
    }

    // Always invalidate stat and parent dir — file size/mtime changed,
    // and the parent directory listing may have changed (new file).
    await this.invalidateMeta(path);
  }

  async unlink(path: string): Promise<void> {
    console.log(`[CACHE-TRACE] unlink(${path}): calling inner.unlink()`);
    await this.inner.unlink(path);
    console.log(`[CACHE-TRACE] unlink(${path}): inner.unlink() OK, invalidating cache`);
    await this.invalidate(path);
  }

  async mkdir(
    path: string,
    options?: { mode?: number; uid?: number; gid?: number; [k: string]: unknown },
  ): Promise<Awaited<ReturnType<CacheableFileSystem['mkdir']>>> {
    const res = await this.inner.mkdir(path, options as never);
    await this.invalidate(path);
    return res;
  }

  async rmdir(path: string): Promise<void> {
    await this.inner.rmdir(path);
    await this.invalidate(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.inner.rename(oldPath, newPath);
    await this.invalidate(oldPath, newPath);
  }

  // ---------------------------------------------------------------------------
  // Byte-level IO (delegated)
  // ---------------------------------------------------------------------------

  async read(
    path: string,
    buffer: Uint8Array,
    start: number,
    end: number,
  ): Promise<void> {
    if (typeof this.inner.read === 'function') {
      return this.inner.read(path, buffer, start, end);
    }
    const data = await this.readFile(path);
    buffer.set(data.slice(start, end), 0);
  }

  async write(
    path: string,
    buffer: Uint8Array,
    offset: number,
  ): Promise<void> {
    if (typeof this.inner.write === 'function') {
      return this.inner.write(path, buffer, offset);
    }
    // Fallback: read-modify-write.
    let existing: Uint8Array;
    try {
      existing = await this.readFile(path);
    } catch {
      existing = new Uint8Array(0);
    }
    const newSize = Math.max(existing.length, offset + buffer.length);
    const merged = new Uint8Array(newSize);
    merged.set(existing);
    merged.set(buffer, offset);
    await this.writeFile(path, merged);
  }
}
