import { describe, it, expect } from 'vitest';
import { MemoryCacheStore, IdbCacheStore, type CacheValue } from '../src/index';

const val: CacheValue = { value: new Uint8Array([1, 2, 3]), cachedAt: Date.now() };

describe('CacheStore.purgeKeepFiles', () => {
  it('removes .keep entries but keeps real data (MemoryCacheStore)', async () => {
    const s = new MemoryCacheStore();
    await s.set('/a/.keep', val);
    await s.set('/b/c/.keep', val);
    await s.set('/.keep', val);
    await s.set('/b/data.json', val);

    await s.purgeKeepFiles();

    expect(await s.get('/a/.keep')).toBeUndefined();
    expect(await s.get('/b/c/.keep')).toBeUndefined();
    expect(await s.get('/.keep')).toBeUndefined();
    expect(await s.get('/b/data.json')).toBeDefined();
  });

  it('IdbCacheStore.purgeKeepFiles is safe when IndexedDB is unavailable', async () => {
    // In a Node test environment IndexedDB is absent, so every store op is a
    // best-effort no-op that resolves without throwing.
    const s = new IdbCacheStore('pfx:');
    await expect(s.purgeKeepFiles()).resolves.toBeUndefined();
  });
});
