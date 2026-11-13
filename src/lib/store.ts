import { put } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { appUrl, devMemoryStore } from "./config";

/**
 * Storage for shared videos: small records in Redis (Upstash, via the Vercel
 * Marketplace) and photos in Vercel Blob. REELBOT_DEV_STORE=memory swaps in an
 * in-process store for local development only — it does not survive restarts
 * and is not shared between serverless instances.
 */

export interface KV {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  pushJson(key: string, value: unknown): Promise<void>;
  listJson<T>(key: string): Promise<T[]>;
  hset(key: string, field: string, value: number): Promise<void>;
  hgetall(key: string): Promise<Record<string, number>>;
  /** Increments a counter, setting its TTL on first use. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

class UpstashKV implements KV {
  private redis = new Redis({
    url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)!,
    token: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)!,
  });
  async getJson<T>(key: string) {
    return (await this.redis.get<T>(key)) ?? null;
  }
  async setJson(key: string, value: unknown, ttlSeconds?: number) {
    if (ttlSeconds) await this.redis.set(key, value, { ex: ttlSeconds });
    else await this.redis.set(key, value);
  }
  async pushJson(key: string, value: unknown) {
    await this.redis.rpush(key, value);
  }
  async listJson<T>(key: string) {
    return this.redis.lrange<T>(key, 0, -1);
  }
  async hset(key: string, field: string, value: number) {
    await this.redis.hset(key, { [field]: value });
  }
  async hgetall(key: string) {
    return ((await this.redis.hgetall<Record<string, number>>(key)) ?? {}) as Record<string, number>;
  }
  async incr(key: string, ttlSeconds: number) {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
}

type Mem = { kv: Map<string, unknown>; blobs: Map<string, { bytes: Uint8Array; type: string }> };
const globalMem = globalThis as unknown as { __reelbotMem?: Mem };
const mem: Mem = (globalMem.__reelbotMem ??= { kv: new Map(), blobs: new Map() });

class MemoryKV implements KV {
  async getJson<T>(key: string) {
    return (structuredClone(mem.kv.get(key)) as T) ?? null;
  }
  async setJson(key: string, value: unknown) {
    mem.kv.set(key, structuredClone(value));
  }
  async pushJson(key: string, value: unknown) {
    const list = (mem.kv.get(key) as unknown[]) ?? [];
    list.push(structuredClone(value));
    mem.kv.set(key, list);
  }
  async listJson<T>(key: string) {
    return structuredClone((mem.kv.get(key) as T[]) ?? []);
  }
  async hset(key: string, field: string, value: number) {
    const h = (mem.kv.get(key) as Record<string, number>) ?? {};
    h[field] = value;
    mem.kv.set(key, h);
  }
  async hgetall(key: string) {
    return { ...((mem.kv.get(key) as Record<string, number>) ?? {}) };
  }
  async incr(key: string) {
    const n = ((mem.kv.get(key) as number) ?? 0) + 1;
    mem.kv.set(key, n);
    return n;
  }
}

let kvInstance: KV | null = null;
export function kv(): KV {
  kvInstance ??= devMemoryStore() ? new MemoryKV() : new UpstashKV();
  return kvInstance;
}

/** Stores a photo publicly (unguessable URL) and returns its URL. */
export async function putPhoto(bytes: Uint8Array, contentType: string, shareKey: string): Promise<string> {
  const ext = contentType.startsWith("image/")
    ? contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"
    : contentType.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
  if (devMemoryStore()) {
    const key = `${shareKey}-${crypto.randomUUID()}.${ext}`;
    mem.blobs.set(key, { bytes, type: contentType });
    return `${appUrl()}/api/shares/dev-blob/${key}`;
  }
  const blob = await put(`shares/${shareKey}/photo.${ext}`, Buffer.from(bytes), {
    access: "public",
    addRandomSuffix: true,
    contentType,
  });
  return blob.url;
}

export function devBlob(key: string) {
  return devMemoryStore() ? mem.blobs.get(key) ?? null : null;
}

/** Hosts that shared photo URLs may point at (for the image proxy). */
export function isSharedPhotoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (devMemoryStore() && raw.startsWith(`${appUrl()}/api/shares/dev-blob/`)) return true;
    return u.protocol === "https:" && u.hostname.endsWith(".public.blob.vercel-storage.com");
  } catch {
    return false;
  }
}
