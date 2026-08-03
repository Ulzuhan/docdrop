#!/usr/bin/env node
/**
 * Completes the standalone output after the build.
 *
 * `next build` leaves the server and its dependencies in .next/standalone, but NOT
 * the static assets: .next/static and public have to be copied by hand or the app
 * starts with no styles and no JavaScript. Runs as a postbuild step.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");

if (!fs.existsSync(standalone)) {
  console.error("[docdrop] No standalone output; is 'output: standalone' missing from next.config?");
  process.exit(1);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

copyDir(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copyDir(path.join(root, "public"), path.join(standalone, "public"));

// The launcher with the adjusted timeouts ships next to the server, so deployment
// only has to copy this one directory.
fs.copyFileSync(path.join(__dirname, "start.js"), path.join(standalone, "start.js"));

// The build tracer cannot resolve the data directory statically (it comes from an env
// var or process.cwd()), so it traces the whole project and copies UPLOADED FILES into
// the standalone output — user content inside a deployment artifact. Neither
// outputFileTracingExcludes (ignored by the Turbopack tracer) nor a turbopackIgnore
// comment prevents it, so it is removed here, where the outcome is guaranteed.
const strayData = path.join(standalone, path.basename(dataDirName()));
if (fs.existsSync(strayData)) {
  const size = dirSize(strayData);
  fs.rmSync(strayData, { recursive: true, force: true });
  console.log(`[docdrop] removed ${(size / 1024 ** 2).toFixed(0)} MB of traced upload data from the standalone output`);
}

function dataDirName() {
  const configured = process.env.DOCDROP_DATA_DIR?.trim();
  return configured ? path.basename(configured) : ".docdrop-uploads";
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      try {
        total += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
      } catch {}
    }
  }
  return total;
}

console.log("[docdrop] standalone ready (static assets + launcher)");
