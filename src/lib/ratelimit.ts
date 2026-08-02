/**
 * Límite de peticiones por IP, en memoria.
 *
 * Tailscale Funnel no trae WAF ni rate limiting (a diferencia de Cloudflare), así que
 * esto es lo único que frena la fuerza bruta contra el login y el abuso del endpoint
 * de subida. Vive en memoria: se reinicia con el proceso y no sirve para varias
 * instancias, pero para un servicio de un solo nodo cumple.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/**
 * IP del cliente para contabilizar el límite.
 *
 * Comprobado contra el proxy real de Tailscale (serve y funnel): SOBRESCRIBE
 * X-Forwarded-For con la IP de origen y descarta el valor que mande el cliente, así
 * que la cabecera es de fiar cuando hay proxy delante. Se toma el último elemento de
 * la lista, que es siempre el que escribe el proxy más cercano.
 *
 * No se usa X-Real-Ip como alternativa: Tailscale NO la limpia y el cliente puede
 * inventarla, lo que permitiría cambiar de identidad en cada petición y esquivar el
 * límite. Sin proxy (acceso directo al puerto), todas las peticiones caen en el mismo
 * cubo, que es el comportamiento prudente.
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
  // Barrido perezoso para que el Map no crezca sin límite con IPs de un solo uso.
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
 * Ventana deslizante: `limit` peticiones por `windowMs` para una clave dada
 * (normalmente "accion:ip").
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

/** Respuesta 429 con Retry-After. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    { error: "Too many requests. Slow down." },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}

/** Olvida los intentos de una clave (se llama tras un login correcto). */
export function resetLimit(key: string): void {
  buckets.delete(key);
}
