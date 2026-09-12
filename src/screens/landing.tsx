import { useEffect, useState } from "react";
import {
  Check,
  Clock,
  FileUp,
  Flame,
  Inbox,
  Link2,
  Lock,
  LogIn,
  Package,
  ShieldCheck,
  Smartphone,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { Header } from "@/components/header";
import { Brand } from "@/components/brand";
import { LinkButton } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Ring } from "@/components/ui/ring";
import { FileIcon } from "@/components/file-icon";
import { SIGN_IN_URL } from "@/lib/api";
import { toast } from "@/lib/toast";

/**
 * What somebody without a session sees: what this is, and the way in. The
 * enrollment button exists only when whoever runs the instance configured a
 * self-service flow at the identity provider.
 */
export function Landing({ enrollUrl }: { enrollUrl: string | null }) {
  // The provider bounced the sign-in: say so once and clean the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") !== "signin") return;
    window.history.replaceState({}, "", "/");
    toast.error("Sign-in did not complete", "Try again; if it keeps happening, ask whoever runs this instance.");
  }, []);

  return (
    <>
      <Header>
        <LinkButton href={SIGN_IN_URL} variant="ghost" size="sm">
          <LogIn />
          Sign in
        </LinkButton>
      </Header>

      <main className="pb-safe">
        <section className="land-hero">
          <div className="drops" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <div className="container land-hero-grid">
            <div className="land-copy rise">
              <span className="eyebrow">Self-hosted · end-to-end encrypted</span>
              <h1 className="land-h1">
                Send the whole file. <span className="ember-text">Then let it vanish.</span>
              </h1>
              <p className="land-lede">
                The video off your camera, untouched. No recompressing it into mush, no ten-minute upload that dies
                at 80%, no account needed on the other end. Just a link that burns out when you say so.
              </p>
              <div className="land-cta">
                {enrollUrl && (
                  <LinkButton href={enrollUrl} variant="primary" size="lg">
                    <UserPlus />
                    Request an account
                  </LinkButton>
                )}
                <LinkButton href={SIGN_IN_URL} variant={enrollUrl ? "outline" : "primary"} size="lg">
                  <LogIn />
                  Sign in
                </LinkButton>
              </div>
              <div className="land-fine">
                <span>Got a guest link instead? Open it — it works without an account.</span>
                {enrollUrl && (
                  <span>Already have an account elsewhere in this family of services? Use the same button.</span>
                )}
              </div>
            </div>

            <LiveDemo />
          </div>
        </section>

        <section className="land-section">
          <div className="container">
            <div className="land-section-head">
              <span className="eyebrow">How it works</span>
              <h2>Three steps, and nothing to install on the other side</h2>
            </div>
            <ol className="steps">
              <li className="card step">
                <span className="step-n">1</span>
                <h3>Drop the file</h3>
                <p>
                  Anything up to 10 GB. It is encrypted in your browser and sent in chunks, so a dropped connection
                  resumes where it stopped.
                </p>
              </li>
              <li className="card step">
                <span className="step-n">2</span>
                <h3>Send the link</h3>
                <p>
                  Copy it, share it, or show a QR code to the phone next to you. The link is the permission and it
                  carries the key.
                </p>
              </li>
              <li className="card step">
                <span className="step-n">3</span>
                <h3>Watch it burn out</h3>
                <p>
                  You choose the lifetime and an optional download limit. When either runs out, the file is deleted.
                  Not archived, deleted.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section className="land-section">
          <div className="container">
            <div className="land-section-head">
              <span className="eyebrow">Why this and not a chat app</span>
              <h2>Built for the files that do not fit anywhere else</h2>
            </div>
            <ul className="features">
              {FEATURES.map(({ Icon, title, body, tone }) => (
                <li key={title} className="card feature" data-tone={tone}>
                  <span className="feature-icon">
                    <Icon aria-hidden />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="land-close">
          <div className="container">
            <div className="card land-close-card">
              <Brand />
              <h2>Nothing sits here forever</h2>
              <p>
                Every file carries its own expiry, and a download limit if you want one. When it runs out it is gone —
                not archived, not backed up somewhere else.
              </p>
              <LinkButton href={enrollUrl ?? SIGN_IN_URL} variant="primary" size="lg">
                {enrollUrl ? <UserPlus /> : <LogIn />}
                {enrollUrl ? "Request an account" : "Sign in"}
              </LinkButton>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

/**
 * The screen that matters, alive: a big file going up, its link appearing,
 * two more files counting down. Showing the result says more than describing
 * it. A tiny state machine drives it; reduced motion freezes it mid-upload.
 */
function LiveDemo() {
  const [pct, setPct] = useState(38);
  const [phase, setPhase] = useState<"uploading" | "linked">("uploading");

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let value = 38;
    let linkedAt = 0;
    const tick = setInterval(() => {
      if (linkedAt) {
        if (Date.now() - linkedAt > 2600) {
          linkedAt = 0;
          value = 0;
          setPhase("uploading");
          setPct(0);
        }
        return;
      }
      value = Math.min(100, value + 0.9 + Math.random() * 1.4);
      setPct(value);
      if (value >= 100) {
        linkedAt = Date.now();
        setPhase("linked");
      }
    }, 90);
    return () => clearInterval(tick);
  }, []);

  const loaded = 6.0 * (pct / 100);

  return (
    <div className="demo-wrap" aria-hidden>
      <div className="card demo">
        <div className="demo-top">
          <span>Your files</span>
          <span className="count mono faint">3</span>
          <span className="gauge">
            <span className="gauge-bar">
              <span style={{ width: "31%" }} />
            </span>
            <span className="num">6.2 GB / 20 GB</span>
          </span>
        </div>
        <ul className="demo-rows">
          <li>
            <FileIcon kind="video" size="sm" />
            <div>
              <p className="name truncate">GX010248.MP4</p>
              <p className="sub">
                {phase === "linked" ? "6.0 GB · just now · encrypted" : `${loaded.toFixed(1)} GB of 6.0 GB · 48 MB/s`}
              </p>
            </div>
            {phase === "linked" ? (
              <span className="demo-linked">
                <Check aria-hidden />
                link copied
              </span>
            ) : (
              <span className="pct">{Math.round(pct)}%</span>
            )}
          </li>
          <li>
            <FileIcon kind="archive" size="sm" />
            <div>
              <p className="name truncate">siargao-photos.zip</p>
              <p className="sub">218 MB · 2h ago · 1/5 downloads</p>
            </div>
            <Ring fraction={0.62} size={36} stroke={3} label="22h" title="Expires in 22 hours" />
          </li>
          <li>
            <FileIcon kind="encrypted" size="sm" />
            <div>
              <p className="name truncate">contract-signed.pdf</p>
              <p className="sub">1.2 MB · yesterday · encrypted · 1 download left</p>
            </div>
            <Ring fraction={0.08} size={36} stroke={3} label="41m" tone="danger" title="Expires in 41 minutes" />
          </li>
        </ul>
        <div className="demo-foot">
          <div className="demo-foot-row">
            <span>{phase === "linked" ? "Uploaded and encrypted in the browser" : "Uploading · resumes if the connection drops"}</span>
            <span className="num">{phase === "linked" ? "6.0 GB" : `${loaded.toFixed(1)} GB / 6.0 GB`}</span>
          </div>
          <Progress value={pct} live={phase === "uploading"} size="sm" tone={phase === "linked" ? "ok" : undefined} />
        </div>
      </div>
    </div>
  );
}

const FEATURES: { Icon: LucideIcon; title: string; body: string; tone?: "ice" }[] = [
  {
    Icon: FileUp,
    title: "Files up to 10 GB",
    body: "Sent in chunks with checksums, so a dropped connection resumes where it stopped instead of starting over.",
  },
  {
    Icon: Lock,
    title: "Encrypted before it leaves",
    body: "AES-256-GCM in your browser. The key travels in the part of the link the server never receives.",
    tone: "ice",
  },
  {
    Icon: Flame,
    title: "Self-destructing",
    body: "One hour to three days, and an optional download limit. After that the content is gone, not archived.",
  },
  {
    Icon: Smartphone,
    title: "Survives a phone",
    body: "Keeps the screen awake while it uploads, and installs as an app that sits in the system share menu.",
  },
  {
    Icon: Inbox,
    title: "Guest links to receive",
    body: "Need something sent to you? Hand out a temporary link that only lets the other person upload.",
    tone: "ice",
  },
  {
    Icon: Package,
    title: "Several files, one ZIP",
    body: "Tick a few and download them together, streamed straight from the server without recompression.",
  },
  {
    Icon: Link2,
    title: "The link is the permission",
    body: "Whoever receives it needs no account and installs nothing. Show a QR code to hand it over in person.",
  },
  {
    Icon: Clock,
    title: "Previews before the download",
    body: "Look at a photo, play a clip or a track before spending gigabytes or one of the allowed downloads.",
  },
  {
    Icon: ShieldCheck,
    title: "Nobody wandering in",
    body: "Accounts come from your identity provider and are approved one by one. Your list is yours alone.",
  },
];
