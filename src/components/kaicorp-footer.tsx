/* GENERADO por kaicorplabs/tools/sync-theme.sh — NO EDITAR AQUÍ.
   El original está en el repo kaicorplabs (theme/). */
import Link from "next/link";

/**
 * Pie común de KaiCorp Labs.
 *
 * GENERADO — se copia desde el repo `kaicorplabs` con `tools/sync-theme.sh`.
 * No editar aquí: editar el original y sincronizar.
 *
 * Usa los tokens `--kc-*` y no los de la aplicación, a propósito: el cromado
 * (cabecera y pie) es lo que se reconoce igual en los cinco servicios,
 * mientras cada app conserva su propia paleta puertas adentro.
 *
 * Lleva enlaces al resto porque quien usa dos de estas aplicaciones no debería
 * tener que teclear la URL de la otra.
 */
const SERVICES = [
  { name: "TabUp", url: "https://tabup.kaicorplabs.com", slug: "tabup" },
  { name: "QR-Forge", url: "https://qr.kaicorplabs.com", slug: "qr-forge" },
  { name: "DocDrop", url: "https://docdrop.kaicorplabs.com", slug: "docdrop" },
  { name: "SecretDrop", url: "https://secret.kaicorplabs.com", slug: "secretdrop" },
  { name: "Pixelforge", url: "https://pixel.kaicorplabs.com", slug: "pixelforge" },
];

export function KaiCorpFooter({ current }: { current?: string }) {
  return (
    <footer
      className="mt-auto border-t px-4 py-5 sm:px-6"
      style={{
        borderColor: "var(--kc-line)",
        background: "var(--kc-bg)",
        fontFamily: "var(--kc-font-sans)",
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
        <Link
          href="https://kaicorplabs.com"
          className="flex items-center gap-2 text-xs transition-opacity hover:opacity-80"
          style={{ color: "var(--kc-text-2)" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kaicorp-mark.png" alt="" width={18} height={18} className="block size-[18px]" />
          <span>
            Built by{" "}
            <span style={{ color: "var(--kc-text-1)", fontWeight: 500 }}>KaiCorp Labs</span>
          </span>
        </Link>

        <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs">
          {SERVICES.map((s) =>
            s.slug === current ? (
              <span key={s.slug} aria-current="page" style={{ color: "var(--kc-text-3)" }}>
                {s.name}
              </span>
            ) : (
              <a
                key={s.slug}
                href={s.url}
                className="transition-colors hover:opacity-100"
                style={{ color: "var(--kc-text-2)" }}
              >
                {s.name}
              </a>
            )
          )}
        </nav>
      </div>
    </footer>
  );
}
