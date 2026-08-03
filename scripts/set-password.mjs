#!/usr/bin/env node
/**
 * Generates DocDrop credentials.
 *
 *   node scripts/set-password.mjs [password]
 *
 * With no argument it invents a strong password. Prints the two variables to put in
 * the service environment file. The password is never stored in plain text: only its
 * scrypt hash.
 */
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2] ?? randomBytes(18).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password.normalize("NFKC"), salt, 64).toString("hex");
const secret = randomBytes(32).toString("hex");

console.log(`# Password (save it in your manager, it is not shown again):`);
console.log(`#   ${password}`);
console.log(``);
console.log(`DOCDROP_PASSWORD_HASH=scrypt$${salt}$${hash}`);
console.log(`DOCDROP_SESSION_SECRET=${secret}`);
