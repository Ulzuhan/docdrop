/**
 * Streaming ZIP builder, no dependencies.
 *
 * DECISIONS:
 *
 * - **No compression** ("store" method). What gets shared here is video and photos,
 *   already compressed: running them through deflate would burn CPU to save nothing.
 *   This way the archive streams out at disk speed and merely groups files together.
 *
 * - **Data descriptors** (flag bit 3). Lets the CRC and sizes be written AFTER the
 *   content, so there is no need to read each file twice or hold it in memory just
 *   to compute the CRC up front.
 *
 * - **ZIP64 when needed**. A 7 GB video does not fit in the 32-bit fields of the
 *   classic format; without this the archive would come out corrupt in exactly the
 *   use case this service exists for.
 */
import { createReadStream } from "fs";
import { Readable } from "stream";

export interface ZipEntry {
  /** Name inside the archive. */
  name: string;
  /** Path to the content on disk. */
  path: string;
  /** Size known up front, so we can decide whether ZIP64 is needed. */
  size: number;
  /** File date, for the archive metadata. */
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

// ─── MS-DOS date format ──────────────────────────────────────────────
function dosDateTime(date: Date): { time: number; date: number } {
  // The format only goes back to 1980 and stores seconds in steps of two.
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const ZIP64_THRESHOLD = 0xfffffffe;

/**
 * Builds the archive as a stream. The caller just pipes it out as-is.
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

      // ── Local file header ───────────────────────────────────────
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // signature
      local.writeUInt16LE(zip64 ? 45 : 20, 4); // version needed
      // bit 3: sizes and CRC live in the descriptor · bit 11: UTF-8 name
      local.writeUInt16LE(0x0008 | 0x0800, 6);
      local.writeUInt16LE(0, 8); // method: store
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14); // CRC (in the descriptor)
      local.writeUInt32LE(0, 18); // compressed size (idem)
      local.writeUInt32LE(0, 22); // uncompressed size (idem)
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // no extra fields

      yield Buffer.concat([local, nameBuf]);
      const entryOffset = offset;
      offset += local.length + nameBuf.length;

      // ── Content ─────────────────────────────────────────────────
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

      // ── Data descriptor ─────────────────────────────────────────
      // With ZIP64 the sizes take 8 bytes instead of 4.
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

    // ── Central directory ─────────────────────────────────────────
    const centralStart = offset;
    for (const entry of placed) {
      const nameBuf = Buffer.from(entry.name, "utf8");
      const { time, date } = dosDateTime(entry.mtime);
      // The ZIP64 extra field is needed when the size or the offset do not fit.
      const needsExtra = entry.zip64 || entry.offset > ZIP64_THRESHOLD;
      const extra = needsExtra ? Buffer.alloc(28) : Buffer.alloc(0);

      if (needsExtra) {
        extra.writeUInt16LE(0x0001, 0); // ZIP64 tag
        extra.writeUInt16LE(24, 2); // field size
        extra.writeBigUInt64LE(BigInt(entry.size), 4); // uncompressed
        extra.writeBigUInt64LE(BigInt(entry.size), 12); // compressed
        extra.writeBigUInt64LE(BigInt(entry.offset), 20); // offset
      }

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(45, 4); // version made by
      central.writeUInt16LE(needsExtra ? 45 : 20, 6); // version needed
      central.writeUInt16LE(0x0008 | 0x0800, 8);
      central.writeUInt16LE(0, 10); // store
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.size, 20);
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.size, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32); // no comment
      central.writeUInt16LE(0, 34); // disk 0
      central.writeUInt16LE(0, 36); // internal attributes
      central.writeUInt32LE(0, 38); // external attributes
      central.writeUInt32LE(needsExtra ? 0xffffffff : entry.offset, 42);

      yield Buffer.concat([central, nameBuf, extra]);
      offset += central.length + nameBuf.length + extra.length;
    }

    const centralSize = offset - centralStart;
    const needsZip64End = centralStart > ZIP64_THRESHOLD || placed.length > 0xfffe;

    // ── End of central directory (ZIP64 when applicable) ──────────
    if (needsZip64End) {
      const end64 = Buffer.alloc(56);
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(BigInt(44), 4); // record size
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeUInt32LE(0, 16); // disk
      end64.writeUInt32LE(0, 20); // directory disk
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
    end.writeUInt16LE(0, 20); // no comment
    yield end;
  }

  return Readable.from(generate());
}

/** Avoids duplicate names inside the archive: "clip.mp4", "clip (2).mp4"… */
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
