import { describe, it, expect } from "vitest";
import { buildReadCacheKey } from "./token-saver.ts";

describe("buildReadCacheKey", () => {
  it("produces different keys for different offsets on same path", () => {
    const key1 = buildReadCacheKey("file.ts", 0, 50);
    const key2 = buildReadCacheKey("file.ts", 50, 50);
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different limits on same path", () => {
    const key1 = buildReadCacheKey("file.ts", 0, 50);
    const key2 = buildReadCacheKey("file.ts", 0, 100);
    expect(key1).not.toBe(key2);
  });

  it("produces same key for same path, offset, and limit", () => {
    const key1 = buildReadCacheKey("file.ts", 0, 50);
    const key2 = buildReadCacheKey("file.ts", 0, 50);
    expect(key1).toBe(key2);
  });

  it("is backward compatible: no params equals offset=0 limit='all'", () => {
    const key1 = buildReadCacheKey("file.ts");
    const key2 = buildReadCacheKey("file.ts", 0);
    const key3 = buildReadCacheKey("file.ts", 0, "all");
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  it("produces different keys for different paths", () => {
    const key1 = buildReadCacheKey("a.ts");
    const key2 = buildReadCacheKey("b.ts");
    expect(key1).not.toBe(key2);
  });
});
