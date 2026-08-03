/**
 * Per-IP rate limiting, in memory.
 *
 * A tunnel in front of this service brings no WAF and no rate limiting of its own,
 * so this is the only thing standing between the login and a brute-force attempt, or
 * between the upload endpoint and abuse. It lives in memory: it resets with the
 * process and does not work across instances, but for a single-node service it does
 * the job.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/**
 * Client IP used to account for the limit.
 *
 * Verified against a real Tailscale proxy (both serve and funnel): it OVERWRITES
 * X-Forwarded-For with the origin IP and discards whatever the client sent, so the
 * header can be trusted when there is a proxy in front. The last element of the list
 * is taken, which is always the one written by the closest proxy.
 *
 * X-Real-Ip is deliberately not used as a fallback: Tailscale does NOT strip it and
 * a client can make it up, which would allow changing identity on every request and
 * dodging the limit. With no proxy (direct access to the port) every request falls
 * into the same bucket, which is the cautious behaviour.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return "direct";
}

function sweep(now: number) {
  // Lazy sweep so the Map does not grow unbounded with one-off IPs.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.hits.length === 0 || now - bucket.hits[bucket.hits.length - 1] > 3_600_000) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Sliding window: `limit` requests per `windowMs` for a given key (usually
 * "action:ip").
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSeconds: 0 };
}

/** 429 response with Retry-After. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: "Too many requests. Slow down." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

/** Forgets the attempts for a key (called after a successful login). */
export function resetLimit(key: string): void {
  buckets.delete(key);
}
