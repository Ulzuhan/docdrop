/* GENERADO por kaicorplabs/tools/sync-theme.sh — NO EDITAR AQUÍ.
   El original está en el repo kaicorplabs (theme/). */
import Link from "next/link";

/**
 * Cabecera común de KaiCorp Labs.
 *
 * GENERADO — se copia desde el repo `kaicorplabs` con `tools/sync-theme.sh`.
 * No editar aquí: editar el original y sincronizar.
 *
 * La marca lleva a la web pública y el nombre del servicio a su propia
 * portada, que es lo que espera quien usa dos o tres de estas aplicaciones.
 * El hueco de la derecha lo llena cada app con lo suyo — sesión, medidor de
 * espacio, idioma — porque unificar la cáscara no debería costarle a nadie
 * una función.
 */
export function KaiCorpHeader({
  app,
  children,
}: {
  /** Nombre del servicio, a la derecha de la marca. */
  app: string;
  /** Acciones de la app: menú de cuenta, ajustes, lo que sea. */
  children?: React.ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-40 border-b backdrop-blur"
      style={{
        borderColor: "var(--kc-line)",
        background: "color-mix(in oklab, var(--kc-bg) 78%, transparent)",
      }}
    >
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="https://kaicorplabs.com"
          className="flex shrink-0 items-center gap-2 transition-opacity hover:opacity-80"
          title="KaiCorp Labs"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/kaicorp-mark.png" alt="" width={24} height={24} className="block size-6" />
        </Link>

        <span aria-hidden style={{ color: "var(--kc-line-2)" }}>
          /
        </span>

        <Link
          href="/"
          className="min-w-0 truncate text-[15px] font-semibold tracking-tight transition-colors"
          style={{ color: "var(--kc-text-1)", fontFamily: "var(--kc-font-display)" }}
        >
          {app}
        </Link>

        {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
