import { NextRequest } from "next/server";
import { writeFile, unlink } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/download/[id]/route";
import { blobPath, claimDownload, createEntryDir, generateId, isResumedTransfer, pendingDownloads, readMeta, withQuotaBudget, writeMeta } from "./store";

async function fixture(maxDownloads = 1, bytes = 14) {
  const id = generateId();
  await createEntryDir(id);
  await writeFile(blobPath(id), Buffer.alloc(bytes, 42));
  await writeMeta({ id, originalName: "fixture.bin", size: bytes, mimeType: "application/octet-stream",
    uploadedAt: Date.now(), expiresAt: Date.now() + 3600_000, downloadCount: 0, maxDownloads });
  return id;
}

function download(id: string, range?: string) {
  return GET(new NextRequest(`http://localhost/api/download/${id}`, {
    headers: { "x-forwarded-for": id, ...(range === undefined ? {} : { range }) },
  }), { params: Promise.resolve({ id }) });
}

describe("download accounting", () => {
  it.each(["bytes=invalid", "bytes=", "bytes=-0", "bytes=14-", "bytes=3-2", "bytes=9007199254740992-"])(
    "invalid range %s neither reserves nor enables free downloads", async (range) => {
      const id = await fixture();
      expect((await download(id, range)).status).toBe(416);
      expect(isResumedTransfer(id, id)).toBe(false);
      const response = await download(id, "bytes=0-");
      expect(response.status).toBe(206);
      expect((await response.arrayBuffer()).byteLength).toBe(14);
      expect((await readMeta(id))?.downloadCount).toBe(1);
      expect((await download(id, "bytes=0-")).status).toBe(410);
    });

  it("cancelling a response releases its slot and a range retry must count", async () => {
    const id = await fixture(1, 1024 * 1024);
    const response = await download(id);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect((await readMeta(id))?.downloadCount).toBe(0);
    expect(isResumedTransfer(id, id)).toBe(false);
    const retry = await download(id, "bytes=0-");
    expect(retry.status).toBe(206);
    expect((await retry.arrayBuffer()).byteLength).toBe(1024 * 1024);
    expect((await readMeta(id))?.downloadCount).toBe(1);
    expect((await download(id)).status).toBe(410);
  });

  it("cancelling a pending read cannot settle the response as delivered", async () => {
    const id = await fixture();
    const reader = (await download(id)).body!.getReader();
    const reading = reader.read();
    await reader.cancel();
    await reading;
    expect((await readMeta(id))?.downloadCount).toBe(0);
    expect(isResumedTransfer(id, id)).toBe(false);
    const retry = await download(id);
    expect(retry.status).toBe(200);
    await retry.arrayBuffer();
  });

  it("a missing blob does not reserve a slot", async () => {
    const id = await fixture();
    await unlink(blobPath(id));
    expect((await download(id)).status).toBe(404);
    expect(isResumedTransfer(id, id)).toBe(false);
    await writeFile(blobPath(id), Buffer.alloc(14));
    const response = await download(id);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("only successfully accounted responses grant Range continuations", async () => {
    const id = await fixture(3);
    const first = await download(id, "bytes=0-3");
    expect(first.status).toBe(206);
    expect(isResumedTransfer(id, id)).toBe(false);
    expect((await first.arrayBuffer()).byteLength).toBe(4);
    expect((await readMeta(id))?.downloadCount).toBe(1);
    expect(isResumedTransfer(id, id)).toBe(true);
    const continuation = await download(id, "bytes=4-");
    expect((await continuation.arrayBuffer()).byteLength).toBe(10);
    expect((await readMeta(id))?.downloadCount).toBe(1);
    const full = await download(id);
    await full.arrayBuffer();
    expect((await readMeta(id))?.downloadCount).toBe(2);
  });

  it("does not allow another response to borrow an unfinished transfer's slot", async () => {
    const id = await fixture();
    const first = await download(id);
    expect((await download(id, "bytes=0-")).status).toBe(410);
    await first.body!.cancel();
    const retry = await download(id);
    expect(retry.status).toBe(200);
    await retry.body!.cancel();
  });

  it("releasing one claim never releases another made in the same millisecond", async () => {
    const id = await fixture(2);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const [a, b] = await Promise.all([claimDownload(id), claimDownload(id)]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) throw new Error("claims failed");
      await a.done(false);
      const c = await claimDownload(id);
      expect(c.ok).toBe(true);
      expect((await claimDownload(id)).ok).toBe(false);
      await b.done(true);
      if (c.ok) await c.done(true);
      expect((await readMeta(id))?.downloadCount).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it("forgets queues for nonexistent ids after they settle", async () => {
    await Promise.all(Array.from({ length: 1000 }, () => claimDownload(generateId())));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pendingDownloads()).toBe(0);
  });

  it("a rejected operation leaves later operations serialized and the queue collectible", async () => {
    const events: string[] = [];
    const first = withQuotaBudget(async () => { events.push("failed"); throw new Error("write failed"); });
    const failure = expect(first).rejects.toThrow("write failed");
    const second = withQuotaBudget(async () => {
      events.push("second start");
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("second end");
    });
    const third = withQuotaBudget(async () => { events.push("third"); });
    await Promise.all([failure, second, third]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["failed", "second start", "second end", "third"]);
    expect(pendingDownloads()).toBe(0);
  });
});
