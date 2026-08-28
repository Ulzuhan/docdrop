/* GENERADO por kaicorplabs/tools/sync-theme.sh — NO EDITAR AQUÍ.
   El original está en el repo kaicorplabs (theme/). */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * El menú de cuenta común de KaiCorp Labs.
 *
 * GENERADO — se copia desde el repo `kaicorplabs` con `tools/sync-theme.sh`.
 * No editar aquí: editar el original y sincronizar.
 *
 * Existe porque las cinco aplicaciones resolvían lo mismo de cinco formas: TabUp con un
 * desplegable de su kit de UI, QR-Forge con otro escrito a mano —con su propio manejo de
 * foco y de Escape—, SecretDrop con el correo en texto y un botón al lado, PixelForge con
 * lo mismo pero **fuera** de la cabecera común, dentro de su herramienta, y DocDrop sin
 * nada: allí se sale desde dentro del panel. Cinco sitios donde acertar con el teclado,
 * cinco formas de decir quién eres y dos maneras de llamar a lo mismo — «Salir» en una,
 * «Sign out» en las otras—, todo bajo la misma marca.
 *
 * **Cuatro líneas, y las cuatro son navegación**: quién eres, dónde se ajusta lo tuyo,
 * dónde vive tu cuenta de verdad y la salida. Lo que cada aplicación tenga de más entra
 * por `extra`; lo que no tenga —una página de ajustes, por ejemplo— simplemente no
 * aparece. Los idiomas y los temas no están aquí a propósito: son de quien los tenga.
 *
 * Sin dependencias, como el resto del cromado: React, `next/link` y los tokens `--kc-*`.
 * Las cinco aplicaciones tienen paletas distintas —`bg-card` en una es `bg-surface` en
 * otra—, así que los colores se toman de las variables comunes, que es el único idioma
 * que hablan todas.
 *
 * Salir lo hace este componente: las cinco publican `POST /api/auth/logout` y contestan
 * con un `next` —la pantalla de salida del proveedor, que es lo que cierra la sesión de
 * verdad— y eso estaba copiado y pegado cuatro veces, con una de ellas ya arreglada
 * después de que salir te volviera a meter dentro.
 */
export interface KaiCorpAccountLabels {
  /** Nombre accesible del botón que abre el menú. */
  menu: string;
  settings: string;
  /** La cuenta en el proveedor de identidad: correo, contraseña, segundo factor. */
  account: string;
  signOut: string;
  signingOut: string;
}

const LABELS_POR_DEFECTO: KaiCorpAccountLabels = {
  menu: "Account",
  settings: "Settings",
  account: "Your account",
  signOut: "Sign out",
  signingOut: "Signing out…",
};

const ITEM_CLASE =
  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors";
const ITEM_ESTILO = { color: "var(--kc-text-1)" };

/**
 * Una línea del menú, para lo que cada aplicación tenga de más.
 *
 * Se exporta para que un añadido no tenga que copiar las clases y acabar con otro
 * tamaño de letra o sin el mismo hueco: es el mismo problema que este componente
 * resuelve entre las cinco, un nivel más abajo.
 */
export function KaiCorpMenuItem({
  href,
  onClick,
  children,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  if (href) {
    return (
      <Link role="menuitem" href={href} className={ITEM_CLASE} style={ITEM_ESTILO}>
        {children}
      </Link>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onClick} className={ITEM_CLASE} style={ITEM_ESTILO}>
      {children}
    </button>
  );
}

export function KaiCorpAccountMenu({
  email,
  name,
  emoji,
  settingsHref,
  accountUrl,
  extra,
  labels,
  beforeSignOut,
}: {
  email: string;
  /** Cómo se llama, si la aplicación lo sabe. Sin nombre se usa la parte del correo. */
  name?: string | null;
  /** Su cara, si la aplicación tiene perfil. Sin ella, la inicial. */
  emoji?: string | null;
  /** La página de ajustes de esta aplicación, si la tiene. */
  settingsHref?: string | null;
  /** La página de la cuenta en el proveedor, si quien despliega la publica. */
  accountUrl?: string | null;
  /** Lo propio de esta aplicación, encima de las líneas comunes. */
  extra?: React.ReactNode;
  labels?: Partial<KaiCorpAccountLabels>;
  /**
   * Lo que esta aplicación tenga que limpiar en el navegador antes de irse.
   *
   * TabUp guarda los grupos para poder abrirlos sin cobertura, y esa caché es del
   * navegador y no de la cuenta: dejarla ahí le entrega los gastos de una persona a
   * quien entre después en ese mismo teléfono. Es lo único que no puede vivir aquí,
   * porque depende de lo que cada aplicación guarde.
   */
  beforeSignOut?: () => void | Promise<void>;
}) {
  const t = { ...LABELS_POR_DEFECTO, ...labels };
  const mostrado = name?.trim() || email.split("@")[0];

  const [abierto, setAbierto] = useState(false);
  const [saliendo, setSaliendo] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  // Cerrar al pulsar fuera o con Escape. Sin esto el panel se queda tapando la página
  // hasta que se vuelve a pulsar el botón, que es como estaba en la única de las cinco
  // que ya tenía menú propio.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: PointerEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && setAbierto(false);
    document.addEventListener("pointerdown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("pointerdown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);

  const salir = async () => {
    setSaliendo(true);
    await beforeSignOut?.();
    const res = await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    // Recargar no basta: la sesión del proveedor sigue viva y «entrar» volvería a entrar
    // sin pedir nada. El `next` que contesta el servidor es su pantalla de salida.
    const next = res ? (await res.json().catch(() => ({}))).next : null;
    window.location.href = next ?? "/";
  };

  const itemStyle = ITEM_CLASE;
  const item = ITEM_ESTILO;

  return (
    <div className="relative" ref={caja}>
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        className="flex items-center gap-2 rounded-full py-1 pr-3 pl-1 transition-colors"
        style={{ color: "var(--kc-text-2)" }}
      >
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold"
          style={{ background: "var(--kc-accent-soft)", color: "var(--kc-accent)" }}
        >
          {emoji || mostrado.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-28 truncate text-sm sm:inline">{mostrado}</span>
        <span className="sr-only">{t.menu}</span>
      </button>

      {abierto && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-60 rounded-xl border p-1 shadow-lg"
          style={{ borderColor: "var(--kc-line)", background: "var(--kc-panel)" }}
        >
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium" style={{ color: "var(--kc-text-1)" }}>
              {mostrado}
            </p>
            <p className="truncate text-xs" style={{ color: "var(--kc-text-3)" }} title={email}>
              {email}
            </p>
          </div>
          <div className="my-1 border-t" style={{ borderColor: "var(--kc-line)" }} />

          {extra}

          {settingsHref && (
            <Link role="menuitem" href={settingsHref} className={itemStyle} style={item}>
              <IconSliders />
              {t.settings}
            </Link>
          )}

          {accountUrl && (
            <a
              role="menuitem"
              href={accountUrl}
              target="_blank"
              rel="noreferrer"
              className={itemStyle}
              style={item}
            >
              <IconExternal />
              {t.account}
            </a>
          )}

          <button
            role="menuitem"
            type="button"
            onClick={salir}
            disabled={saliendo}
            className={`${itemStyle} disabled:opacity-60`}
            style={item}
          >
            <IconExit />
            {saliendo ? t.signingOut : t.signOut}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Los iconos, dibujados aquí.
 *
 * Tres de las cinco aplicaciones traen `lucide-react` y dos no, así que importarlo haría
 * que el cromado común exigiera una dependencia a quien no la tiene. Son tres trazos.
 */
function IconSliders() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
      <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="16" cy="18" r="2" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function IconExit() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}
