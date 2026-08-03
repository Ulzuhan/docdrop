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

console.log("[docdrop] standalone ready (static assets + launcher)");
