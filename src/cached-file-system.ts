import type {
  CacheableFileSystem,
  CacheStore,
  CacheValue,
} from './types.js';

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
   * backend via a conditional request (cheap `304` when unchanged).
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
 *   `readFileMeta`, conditional (`If-None-Match` / `If-Modified-Since`)
 *   requests are used so unchanged content returns a cheap `304`. Otherwise
 *   `getRevision` (ETag / mtimeMs / hash) is used for cheap revalidation.
 * - Mutating operations (`writeFile` / `unlink` / `mkdir` / `rmdir` / `rename`)
 *   invalidate the affected cache entries, so subsequent reads re-validate.
 * - On network failure, the last known-good cached value is returned as a
 *   fallback (except for a `404`, which is always re-thrown so deletions are
 *   noticed).
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

  private isNotFound(err: unknown): boolean {
    return (
      !!err &&
      ((err as { status?: number }).status === 404 ||
        (err as { code?: string }).code === 'ENOENT')
    );
  }

  // ---------------------------------------------------------------------------
  // Reads (cached)
  // ---------------------------------------------------------------------------

  async readFile(path: string): Promise<Uint8Array> {
    const key = `file:${path}`;
    const cached = await this.store.get(key);

    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return cached.value;
    }

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

    // Fallback: generic revision check, then plain read.
    if (typeof this.inner.getRevision === 'function') {
      try {
        const rev = await this.inner.getRevision(path);
        if (cached && rev != null && rev === cached.revision) return cached.value;
      } catch {
        // ignore
      }
    }

    const data = await this.inner.readFile(path);
    await this.store.set(key, {
      value: data,
      revision: undefined,
      cachedAt: Date.now(),
    });
    return data;
  }

  async readdir(path: string): Promise<string[]> {
    const key = `dir:${path}`;
    const cached = await this.store.get(key);

    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return JSON.parse(bytesToStr(cached.value)) as string[];
    }

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

    const items = await this.inner.readdir(path);

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

    if (cached && this.ttlMs > 0 && Date.now() - cached.cachedAt < this.ttlMs) {
      return JSON.parse(bytesToStr(cached.value));
    }

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

    const st = await this.inner.stat(path);

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
      await this.inner.stat(path);
      return true;
    } catch (err) {
      if (this.isNotFound(err)) return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Writes / mutations (delegated + invalidated)
  // ---------------------------------------------------------------------------

  async writeFile(
    path: string,
    data: string | Uint8Array | ArrayBuffer,
    options?: { flag?: string },
  ): Promise<void> {
    await this.inner.writeFile(path, data, options);
    await this.invalidate(path);
  }

  async unlink(path: string): Promise<void> {
    await this.inner.unlink(path);
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
