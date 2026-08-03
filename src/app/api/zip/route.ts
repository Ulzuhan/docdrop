import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { blobPath, claimDownload, contentDisposition, isValidId } from "@/lib/store";
import { createZipStream, uniqueNames, type ZipEntry } from "@/lib/zip";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/ratelimit";

/** Tope de ficheros por ZIP, para que una URL no dispare una descarga desmedida. */
const MAX_ENTRIES = 100;

/**
 * GET /api/zip?ids=a,b,c[&name=viaje] — descarga varios ficheros en un solo ZIP.
 *
 * Público, igual que la descarga suelta: quien tenga los enlaces puede juntarlos.
 * Va por streaming y sin comprimir, así que empieza a bajar de inmediato y no
 * necesita espacio temporal en el servidor.
 *
 * Cada fichero incluido cuenta como una descarga suya. Los que ya no estén
 * disponibles se omiten en silencio en lugar de tumbar el ZIP entero: es preferible
 * recibir 9 de 10 vídeos que un error.
 */
export async function GET(request: NextRequest) {
  const limit = rateLimit(`zip:${clientIp(request)}`, 30, 60_000);
  if (!limit.allowed) return tooManyRequests(limit);

  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];

  if (ids.length === 0) {
    return NextResponse.json({ error: "No ids" }, { status: 400 });
  }
  if (ids.length > MAX_ENTRIES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_ENTRIES})` },
      { status: 400 }
    );
  }
  if (ids.some((id) => !isValidId(id))) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Se reservan las descargas por adelantado: así el contador refleja lo que
  // realmente se va a enviar y se respetan los límites por fichero.
  const entries: ZipEntry[] = [];
  for (const id of ids) {
    const claim = await claimDownload(id);
    if (!claim.ok) continue;
    entries.push({
      name: claim.meta.originalName,
      path: blobPath(id),
      size: claim.meta.size,
      mtime: new Date(claim.meta.uploadedAt),
    });
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: "None of those files are available any more" },
      { status: 410 }
    );
  }

  // Dos ficheros pueden llamarse igual; dentro del ZIP no pueden.
  const names = uniqueNames(entries.map((e) => e.name));
  entries.forEach((entry, i) => {
    entry.name = names[i];
  });

  const requested = request.nextUrl.searchParams.get("name")?.trim();
  const base = requested && /^[\w \-.]{1,60}$/.test(requested) ? requested : "docdrop";
  const stamp = new Date().toISOString().slice(0, 10);

  const zip = createZipStream(entries);

  return new NextResponse(Readable.toWeb(zip) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      // Sin Content-Length: el tamaño final no se conoce hasta terminar de generarlo.
      "Content-Disposition": contentDisposition(`${base}-${stamp}.zip`),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
