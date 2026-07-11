# zen-fs-cache

A generic caching layer for any [zen-fs](https://github.com/weijia/zen-fs) compatible filesystem.

Wrap a backend (e.g. `zen-fs-remotestoragejs`) with `CachedFileSystem` and give it a
`CacheStore` to get HTTP-style revalidation (ETag / Last-Modified / 304) plus pluggable
persistence (memory / IndexedDB).

## Install

```bash
npm install zen-fs-cache
```

> Requires the peer dependency `@zenfs/core` (>=2.3.0).

## Usage

```ts
import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';
import { CachedFileSystem, IdbCacheStore } from 'zen-fs-cache';

const fs = new CachedFileSystem(
  new RemoteStorageFileSystem({ href, token }),
  new IdbCacheStore('myapp:'),
  // Optional. Within `ttlMs` reads hit the cache with zero network
  // round-trips; afterwards a conditional request (cheap 304 if
  // unchanged) revalidates. Writes invalidate affected keys immediately.
  { ttlMs: 2 * 60 * 1000 },
);
```

## API

- `CachedFileSystem(fs, store, options?)` — wraps any zen-fs `FileSystem`.
- `IdbCacheStore(prefix)` — IndexedDB-backed store (browser).
- `MemoryCacheStore()` — in-memory store.
- `createDefaultCache()` — platform-appropriate default store.

## License

MIT
