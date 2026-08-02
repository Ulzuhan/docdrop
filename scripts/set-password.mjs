#!/usr/bin/env node
/**
 * Genera las credenciales de DocDrop.
 *
 *   node scripts/set-password.mjs [contraseña]
 *
 * Sin argumento, inventa una contraseña fuerte. Imprime las dos variables que hay que
 * poner en el fichero de entorno del servicio. La contraseña nunca se guarda en claro:
 * solo su hash scrypt.
 */
import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2] ?? randomBytes(18).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password.normalize("NFKC"), salt, 64).toString("hex");
const secret = randomBytes(32).toString("hex");

console.log(`# Contraseña (guárdala en tu gestor, no vuelve a mostrarse):`);
console.log(`#   ${password}`);
console.log(``);
console.log(`DOCDROP_PASSWORD_HASH=scrypt$${salt}$${hash}`);
console.log(`DOCDROP_SESSION_SECRET=${secret}`);
