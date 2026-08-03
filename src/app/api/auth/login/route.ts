import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  createSessionToken,
  isConfigured,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";
import { clientIp, rateLimit, resetLimit, tooManyRequests } from "@/lib/ratelimit";

// Brute force: 5 attempts per IP every 15 minutes.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  if (!isConfigured()) {
    // No password configured means no way in: fail closed, never open.
    return NextResponse.json(
      { error: "Server not configured. Set DOCDROP_PASSWORD_HASH and DOCDROP_SESSION_SECRET." },
      { status: 503 }
    );
  }

  const key = `login:${clientIp(request)}`;
  const limit = rateLimit(key, MAX_ATTEMPTS, WINDOW_MS);
  if (!limit.allowed) return tooManyRequests(limit);

  let password: unknown;
  try {
    ({ password } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof password !== "string" || password.length === 0 || password.length > 512) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  if (!verifyPassword(password)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = createSessionToken();
  if (!token) {
    return NextResponse.json({ error: "Server not configured" }, { status: 503 });
  }

  resetLimit(key);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
  return response;
}
