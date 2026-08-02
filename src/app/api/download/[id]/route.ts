import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import {
  blobPath,
  claimDownload,
  contentDisposition,
  isValidId,
  retireIfExhausted,
} from "@/lib/store";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

const GONE = { expired: "File expired", exhausted: "Max downloads reached" } as const;

/**
 * GET /api/download/[id] — envía el fichero por streaming.
 *
 * Cambios frente a la versión anterior:
 *  - readFile() cargaba el fichero entero en memoria; ahora va por streaming.
 *  - el contador de descargas se incrementa de forma serializada (ver claimDownload),
 *    antes dos descargas simultáneas podían saltarse el límite.
 *  - se admite Range, para poder reanudar descargas grandes; una petición Range de
 *    continuación no vuelve a contar como descarga nueva.
 *  - Content-Length sale del fichero real, no del tamaño guardado en meta.json.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/download/[id]">) {
  // Ruta pública (el secreto es el id), pero con freno para que nadie use el servicio
  // como cañón de ancho de banda ni intente enumerar ids a lo bruto. El límite es
  // holgado porque una descarga con Range genera varias peticiones.
  const limit = rateLimit(`download:${clientIp(request)}`, 240, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const range = request.headers.get("range");
  const isContinuation = Boolean(range && !/^bytes=0-/.test(range));

  const claim = await claimDownload(id, !isContinuation);
  if (!claim.ok) {
    if (claim.reason === "not_found") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: GONE[claim.reason] }, { status: 410 });
  }
  const meta = claim.meta;

  let size: number;
  try {
    size = (await stat(blobPath(id))).size;
  } catch {
    return NextResponse.json({ error: "File data not found" }, { status: 404 });
  }

  const headers = new Headers({
    "Content-Type": meta.mimeType,
    "Content-Disposition": contentDisposition(meta.originalName),
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });

  // ─── Petición parcial (Range) ──────────────────────────────────────
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    let start: number;
    let end: number;
    if (match[1] === "") {
      // bytes=-N → los últimos N bytes
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }

    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));

    const partial = createReadStream(blobPath(id), { start, end });
    partial.on("close", () => void retireIfExhausted(id).catch(() => {}));
    return new NextResponse(Readable.toWeb(partial) as unknown as ReadableStream, {
      status: 206,
      headers,
    });
  }

  // ─── Envío completo ────────────────────────────────────────────────
  headers.set("Content-Length", String(size));

  const stream = createReadStream(blobPath(id));
  // Cuando termina el envío, si esta era la última descarga permitida, se borra.
  stream.on("close", () => void retireIfExhausted(id).catch(() => {}));

  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
