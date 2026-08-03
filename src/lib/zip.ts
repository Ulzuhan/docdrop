/**
 * Generador de ZIP por streaming, sin dependencias.
 *
 * DECISIONES:
 *
 * - **Sin comprimir** (método "store"). Lo que se comparte aquí son vídeos y fotos,
 *   que ya vienen comprimidos: pasarlos por deflate gastaría CPU para no ahorrar
 *   nada. Así el ZIP sale a velocidad de disco y solo sirve para agrupar.
 *
 * - **Descriptor de datos** (bit 3 de las banderas). Permite escribir el CRC y los
 *   tamaños DESPUÉS del contenido, así que no hay que leer cada fichero dos veces ni
 *   cargarlo en memoria para calcular el CRC por adelantado.
 *
 * - **ZIP64 cuando hace falta**. Un vídeo de 7 GB no cabe en los campos de 32 bits
 *   del formato clásico; sin esto el ZIP saldría corrupto justo en el caso de uso
 *   para el que existe este servicio.
 */
import { createReadStream } from "fs";
import { Readable } from "stream";

export interface ZipEntry {
  /** Nombre dentro del ZIP. */
  name: string;
  /** Ruta en disco del contenido. */
  path: string;
  /** Tamaño conocido de antemano, para poder decidir si hace falta ZIP64. */
  size: number;
  /** Fecha del fichero, para los metadatos del ZIP. */
  mtime: Date;
}

// ─── CRC-32 ──────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Update(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

// ─── Fecha en formato MS-DOS ─────────────────────────────────────────
function dosDateTime(date: Date): { time: number; date: number } {
  // El formato solo llega hasta 1980 y guarda los segundos en pasos de dos.
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const ZIP64_THRESHOLD = 0xfffffffe;

/**
 * Construye el ZIP como un stream. El consumidor solo tiene que enviarlo tal cual.
 */
export function createZipStream(entries: ZipEntry[]): Readable {
  type Placed = ZipEntry & { offset: number; crc: number; zip64: boolean };
  const placed: Placed[] = [];
  let offset = 0;

  async function* generate(): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, "utf8");
      const { time, date } = dosDateTime(entry.mtime);
      const zip64 = entry.size > ZIP64_THRESHOLD;

      // ── Cabecera local ──────────────────────────────────────────
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // firma
      local.writeUInt16LE(zip64 ? 45 : 20, 4); // versión necesaria
      // bit 3: tamaños y CRC van en el descriptor · bit 11: nombre en UTF-8
      local.writeUInt16LE(0x0008 | 0x0800, 6);
      local.writeUInt16LE(0, 8); // método: store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // CRC (va en el descriptor)
      local.writeUInt32LE(0, 18); // comprimido (idem)
      local.writeUInt32LE(0, 22); // sin comprimir (idem)
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // sin campos extra

      yield Buffer.concat([local, nameBuf]);
      const entryOffset = offset;
      offset += local.length + nameBuf.length;

      // ── Contenido ───────────────────────────────────────────────
      let crc = 0xffffffff;
      let written = 0;
      for await (const chunk of createReadStream(entry.path)) {
        const buf = chunk as Buffer;
        crc = crc32Update(crc, buf);
        written += buf.length;
        yield buf;
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      offset += written;

      // ── Descriptor de datos ─────────────────────────────────────
      // Con ZIP64 los tamaños ocupan 8 bytes en vez de 4.
      const descriptor = Buffer.alloc(zip64 ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      if (zip64) {
        descriptor.writeBigUInt64LE(BigInt(written), 8);
        descriptor.writeBigUInt64LE(BigInt(written), 16);
      } else {
        descriptor.writeUInt32LE(written, 8);
        descriptor.writeUInt32LE(written, 12);
      }
      yield descriptor;
      offset += descriptor.length;

      placed.push({ ...entry, size: written, offset: entryOffset, crc, zip64 });
    }

    // ── Directorio central ────────────────────────────────────────
    const centralStart = offset;
    for (const entry of placed) {
      const nameBuf = Buffer.from(entry.name, "utf8");
      const { time, date } = dosDateTime(entry.mtime);
      // Hace falta el campo extra ZIP64 si el tamaño o el desplazamiento no caben.
      const needsExtra = entry.zip64 || entry.offset > ZIP64_THRESHOLD;
      const extra = needsExtra ? Buffer.alloc(28) : Buffer.alloc(0);

      if (needsExtra) {
        extra.writeUInt16LE(0x0001, 0); // etiqueta ZIP64
        extra.writeUInt16LE(24, 2); // tamaño del campo
        extra.writeBigUInt64LE(BigInt(entry.size), 4); // sin comprimir
        extra.writeBigUInt64LE(BigInt(entry.size), 12); // comprimido
        extra.writeBigUInt64LE(BigInt(entry.offset), 20); // desplazamiento
      }

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(45, 4); // versión que lo creó
      central.writeUInt16LE(needsExtra ? 45 : 20, 6); // versión necesaria
      central.writeUInt16LE(0x0008 | 0x0800, 8);
      central.writeUInt16LE(0, 10); // store
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.size, 20);
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.size, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32); // sin comentario
      central.writeUInt16LE(0, 34); // disco 0
      central.writeUInt16LE(0, 36); // atributos internos
      central.writeUInt32LE(0, 38); // atributos externos
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.offset, 42);

      yield Buffer.concat([central, nameBuf, extra]);
      offset += central.length + nameBuf.length + extra.length;
    }

    const centralSize = offset - centralStart;
    const needsZip64End = centralStart > ZIP64_THRESHOLD || placed.length > 0xfffe;

    // ── Fin del directorio (ZIP64 si procede) ─────────────────────
    if (needsZip64End) {
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(BigInt(44), 4); // tamaño del registro
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeUInt32LE(0, 16); // disco
      end64.writeUInt32LE(0, 20); // disco del directorio
      end64.writeBigUInt64LE(BigInt(placed.length), 24);
      end64.writeBigUInt64LE(BigInt(placed.length), 32);
      end64.writeBigUInt64LE(BigInt(centralSize), 40);
      end64.writeBigUInt64LE(BigInt(centralStart), 48);
      yield end64;

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(offset), 8);
      locator.writeUInt32LE(1, 16);
      yield locator;
      offset += end64.length + locator.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(placed.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(placed.length, 0xffff), 10);
    end.writeUInt32LE(Math.min(centralSize, 0xffffffff), 12);
    end.writeUInt32LE(needsZip64End ? 0xffffffff : centralStart, 16);
    end.writeUInt16LE(0, 20); // sin comentario
    yield end;
  }

  return Readable.from(generate());
}

/** Evita nombres repetidos dentro del ZIP: "clip.mp4", "clip (2).mp4"… */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;

    const dot = name.lastIndexOf(".");
    return dot > 0
      ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`
      : `${name} (${count + 1})`;
  });
}
