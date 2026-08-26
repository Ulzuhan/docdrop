/**
 * Firma y salto entre servicios.
 *
 * Va en el layout, no solo en la portada: alguien que use dos de estas
 * aplicaciones no debería tener que teclear la URL de la otra.
 */
export function KaiCorpFooter() {
  return (
    <footer className="border-t border-border/60 px-4 py-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-2 text-center sm:flex-row sm:justify-between sm:text-left">
        <p className="text-xs text-muted-foreground">
          Built by{" "}
          <a href="https://kaicorplabs.com" className="font-medium hover:text-foreground transition-colors">
            KaiCorp Labs
          </a>
        </p>
        <nav className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs">
        <a href="https://tabup.kaicorplabs.com" className="text-muted-foreground hover:text-foreground transition-colors">TabUp</a>
        <a href="https://qr.kaicorplabs.com" className="text-muted-foreground hover:text-foreground transition-colors">QR-Forge</a>
        <span className="text-muted-foreground opacity-60" aria-current="page">DocDrop</span>
        <a href="https://secret.kaicorplabs.com" className="text-muted-foreground hover:text-foreground transition-colors">SecretDrop</a>
        <a href="https://pixel.kaicorplabs.com" className="text-muted-foreground hover:text-foreground transition-colors">Pixelforge</a>
        </nav>
      </div>
    </footer>
  );
}
