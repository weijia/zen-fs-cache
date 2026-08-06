# zen-fs-cache

A generic caching layer for any [zen-fs](https://github.com/weijia/zen-fs) compatible filesystem.

Wrap a backend (e.g. `zen-fs-remotestoragejs`, `zen-fs-gitee`) with `CachedFileSystem` and give it a `CacheStore` to get revision-based revalidation plus pluggable persistence (memory / IndexedDB).

## Install

```bash
npm install zen-fs-cache
```

> Requires the peer dependency `@zenfs/core` (>=2.3.0).

## Quick start

```ts
import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';
import { CachedFileSystem, IdbCacheStore } from 'zen-fs-cache';

const fs = new CachedFileSystem(
  new RemoteStorageFileSystem({ href, token }),
  new IdbCacheStore('myapp:'),
);

// First read: fetches from backend, caches the result
const data = await fs.readFile('/configs/app.json');

// Second read: getRevision() returns the same ETag → cached value returned,
// zero content download
const data2 = await fs.readFile('/configs/app.json');

// After write: cache is updated with new content + new revision
await fs.writeFile('/configs/app.json', newContent);
// Next read: getRevision() returns new ETag ≠ cached revision → re-downloads
```

## How it works

### Revalidation strategy (reads)

The cache picks the most efficient available strategy on each read:

```
readFile(path)
  │
  ├─ 1. getRevision(path) — preferred when implemented
  │     Returns a revision token (ETag, blob SHA, mtimeMs, etc.)
  │     Compare with cached revision:
  │       match → return cached value (zero download)
  │       differ → re-download, update cache
  │
  ├─ 2. readFileMeta(path, {ifNoneMatch}) — HTTP conditional GET
  │     Server returns 304 (unchanged) or 200 (new content)
  │
  └─ 3. TTL fallback — return cached value if within ttlMs
```

### Write strategy

- **With `getRevision`**: After `writeFile`, the cache **updates** the cached entry with the new content and a fresh revision token (no re-download needed on next read).
- **Without `getRevision`**: After `writeFile`, the cache **invalidates** the affected entries (next read re-fetches from backend).

### Offline fallback

On network failure (non-404), the last known-good cached value is returned. A `404` is always re-thrown so deletions are noticed.

## `getRevision` — the preferred hook

`getRevision(path)` returns an opaque token that changes when content changes. The cache stores it alongside the content; on subsequent reads it calls `getRevision` again and compares:

```
cached.revision = "a1b2c3d4..."   (stored in IndexedDB)
current.revision = getRevision(path)
  → same?  return cached content (zero download)
  → different? re-download, update cache
```

### What each backend returns

| Backend | Revision token | Source | Network cost |
|---|---|---|---|
| RemoteStorage | HTTP `ETag` | `HEAD` request | 1 round-trip |
| Gitee | Git blob SHA | `shaCache.get(path)` (memory) | **0 round-trips** |
| GitHub | Git blob SHA | `shaCache.get(path)` (memory) | **0 round-trips** |

For Git backends (Gitee/GitHub), the blob SHA is cached in memory at init time (from a single `getTree` API call) and updated on every write (from the API response). So `getRevision` is a pure `Map.get()` — no network access at all.

### When to return `undefined`

- File doesn't exist (deleted or never created)
- Backend can't determine revision (network error)
- Directory paths on Git backends (no directory-level SHA)

Returning `undefined` falls through to the next strategy (`readFileMeta` → TTL → full read).

## `readFileMeta` — HTTP conditional GET

For HTTP backends that support conditional GET (`If-None-Match` / `If-Modified-Since`):

```ts
async readFileMeta(path, { ifNoneMatch, ifModifiedSince }) {
  const headers = {};
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { status: 304 };
  return { status: 200, data: await res.arrayBuffer(), etag: res.headers.get('ETag') };
}
```

| | `getRevision` | `readFileMeta` |
|---|---|---|
| Read (unchanged) | 1 request (or 0 for Git) | 1 request (304) |
| Read (changed) | 1 + 1 requests | 1 request (200 + body) |
| Downloads body on unchanged? | No | No |
| Needs HTTP conditional GET? | No | Yes |
| Works for readdir/stat? | Yes | No (file only) |

If both are implemented, `getRevision` takes priority.

## API

### `CachedFileSystem(inner, store, options?)`

Wraps any `CacheableFileSystem`-compatible backend.

```ts
interface CachedFileSystemOptions {
  /** Optimistic TTL (ms). Within this window, reads skip revalidation entirely.
   *  Default: 0 (always revalidate via getRevision/readFileMeta).
   *  Ignored when getRevision is implemented (revision check is exact). */
  ttlMs?: number;
}
```

### `CacheableFileSystem` interface

Backends must provide standard FS methods (`readFile`, `writeFile`, `readdir`, `stat`, `exists`, `mkdir`, `unlink`, `rmdir`, `rename`) and optionally implement:

- `getRevision(path)` — preferred revalidation hook
- `readFileMeta(path, opts)` — HTTP conditional GET fallback
- `read(path, buffer, start, end)` — byte-level read
- `write(path, buffer, offset)` — byte-level write

Any `@zenfs/core` `FileSystem` subclass already satisfies the required methods.

### `CacheStore` interface

```ts
interface CacheStore {
  get(key: string): Promise<CacheValue | undefined>;
  set(key: string, value: CacheValue): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

Implementations:
- `MemoryCacheStore()` — in-memory `Map`, session-scoped
- `IdbCacheStore(prefix, dbName?, storeName?)` — IndexedDB, persists across reloads
- `createDefaultCache()` — returns `MemoryCacheStore`

### `CacheValue`

```ts
interface CacheValue {
  value: Uint8Array;        // cached content (file bytes or JSON-encoded metadata)
  etag?: string;            // for conditional GET
  lastModified?: string;    // for conditional GET
  revision?: string | number;  // from getRevision() — primary revalidation token
  contentType?: string;
  cachedAt: number;         // epoch ms when stored
}
```

## License

MIT
