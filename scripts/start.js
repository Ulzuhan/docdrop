#!/usr/bin/env node
/**
 * Production entry point, with timeouts adjusted for long uploads.
 *
 * THE PROBLEM: Node aborts any request lasting longer than `server.requestTimeout`,
 * 300,000 ms (5 min) by default. A large upload is ONE single HTTP request, so at
 * ~19 MB/s the cut-off lands around 5.6 GB — a 7 GB file dies just past 80% with no
 * clear error on the client. Next only exposes `keepAliveTimeout`, not
 * `requestTimeout`, and `output: standalone` is incompatible with a custom server
 * (its own docs say so), so the value is adjusted by intercepting the creation of
 * the HTTP server before Next starts.
 *
 * `headersTimeout` stays at 60s: that is the one protecting against clients dribbling
 * headers out. A slow body cannot grow unbounded because /api/upload cuts it off as
 * soon as the maximum size is exceeded.
 */
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const fs = require("node:fs");

const HOURS = 60 * 60 * 1000;
const REQUEST_TIMEOUT = Number(process.env.DOCDROP_REQUEST_TIMEOUT_MS) || 12 * HOURS;
const HEADERS_TIMEOUT = Number(process.env.DOCDROP_HEADERS_TIMEOUT_MS) || 60_000;

let patched = 0;

function patchFactory(module, name) {
  const original = module[name];
  module[name] = function (...args) {
    const server = original.apply(this, args);
    server.requestTimeout = REQUEST_TIMEOUT;
    server.headersTimeout = HEADERS_TIMEOUT;
    patched += 1;
    return server;
  };
}

patchFactory(http, "createServer");
patchFactory(https, "createServer");

// The standalone server chdirs into its own directory, so the default data path
// (relative to cwd) would stop pointing at the project. It is pinned here, before
// handing over control. In production the service manager sets DOCDROP_DATA_DIR.
if (!process.env.DOCDROP_DATA_DIR) {
  process.env.DOCDROP_DATA_DIR = path.join(process.cwd(), ".docdrop-uploads");
}

// standalone's server.js sits next to this file once deployed, and in
// .next/standalone when running from the repository.
const candidates = [
  path.join(__dirname, "server.js"),
  path.join(__dirname, "..", "server.js"),
  path.join(__dirname, "..", ".next", "standalone", "server.js"),
];

const target = candidates.find((candidate) => fs.existsSync(candidate));
if (!target) {
  console.error(
    "[docdrop] Cannot find the Next server. Run 'npm run build' before starting."
  );
  process.exit(1);
}

const minutes = Math.round(REQUEST_TIMEOUT / 60000);
console.log(`[docdrop] per-request limit: ${minutes} min (long uploads allowed)`);

require(target);

// If a future Next version stopped using http.createServer, the adjustment would
// silently not apply and the 5-minute cut-off would come back. Better to find out
// from the log than from a 7 GB upload breaking at 80%.
setTimeout(() => {
  if (patched === 0) {
    console.error(
      "[docdrop] WARNING: could not adjust requestTimeout; uploads longer than " +
        "5 minutes will be cut off. Check scripts/start.js."
    );
  }
}, 5000).unref();
