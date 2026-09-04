import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const store = mkdtempSync(join(tmpdir(), "docdrop-unit-"));
process.env.DOCDROP_DATA_DIR = store;
afterAll(() => rmSync(store, { recursive: true, force: true }));
