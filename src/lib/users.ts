/**
 * DocDrop — the people who can use this instance.
 *
 * Accounts live in Authentik; what is kept here is a local mirror of the
 * identity, so a file can say who uploaded it and a session can point at
 * somebody. There are no passwords in this file and there is no sign-up: both
 * belong to the identity provider, which only issues tokens for people in this
 * application's group.
 *
 * Stored as one JSON file per person under UPLOAD_DIR/users/, the same shape
 * the guest links already use. "users" does not match the hex id format, so
 * every store walker (listMeta, cleanup, usedBytes) skips the directory
 * without knowing it exists.
 */
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { UPLOAD_DIR } from "@/lib/store";

const USERS_DIR = join(UPLOAD_DIR, "users");

export interface DocDropUser {
  id: string;
  /** The `sub` claim from Authentik: stable even if the email changes. */
  oidcSub: string;
  email: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
}

// The file name comes from the sub, hashed: a sub is opaque but not
// guaranteed to be safe as a path, and hashing sidesteps the question.
function fileFor(oidcSub: string): string {
  return join(USERS_DIR, `${createHash("sha256").update(oidcSub).digest("hex")}.json`);
}

async function write(user: DocDropUser): Promise<void> {
  await mkdir(USERS_DIR, { recursive: true });
  await writeFile(fileFor(user.oidcSub), JSON.stringify(user, null, 2));
}

export async function findBySub(oidcSub: string): Promise<DocDropUser | null> {
  try {
    return JSON.parse(await readFile(fileFor(oidcSub), "utf-8")) as DocDropUser;
  } catch {
    return null;
  }
}

export async function findById(id: string): Promise<DocDropUser | null> {
  if (!existsSync(USERS_DIR)) return null;
  let names: string[];
  try {
    names = await readdir(USERS_DIR);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const user = JSON.parse(await readFile(join(USERS_DIR, name), "utf-8")) as DocDropUser;
      if (user.id === id) return user;
    } catch {
      // Un fichero ilegible no debe tumbar la búsqueda.
    }
  }
  return null;
}

/** The person behind an identity, created the first time they arrive. */
export async function upsertFromIdentity(identity: {
  sub: string;
  email: string;
  name?: string;
}): Promise<DocDropUser> {
  const now = Date.now();
  const existing = await findBySub(identity.sub);

  const user: DocDropUser = existing
    ? { ...existing, email: identity.email, name: identity.name, lastSeenAt: now }
    : {
        id: randomUUID(),
        oidcSub: identity.sub,
        email: identity.email,
        name: identity.name,
        createdAt: now,
        lastSeenAt: now,
      };

  await write(user);
  return user;
}

/** What to label this person's uploads with. */
export function displayName(user: DocDropUser): string {
  return user.name?.trim() || user.email.split("@")[0];
}
