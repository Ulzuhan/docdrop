/**
 * The footer: attribution, and links to the rest of the family only when
 * whoever runs the instance asks for them (KAICORP_FOOTER_LINKS, passed by the
 * server as `data-footer-links`). On somebody else's deployment those links are
 * advertising for services that are not theirs.
 */
const SERVICES = [
  { name: "TabUp", url: "https://tabup.kaicorplabs.com", slug: "tabup" },
  { name: "QR-Forge", url: "https://qr.kaicorplabs.com", slug: "qr-forge" },
  { name: "DocDrop", url: "https://docdrop.kaicorplabs.com", slug: "docdrop" },
  { name: "SecretDrop", url: "https://secret.kaicorplabs.com", slug: "secretdrop" },
  { name: "Pixelforge", url: "https://pixel.kaicorplabs.com", slug: "pixelforge" },
  { name: "LinkUp", url: "https://link.kaicorplabs.com", slug: "linkup" },
];

export function Footer({ links }: { links: boolean }) {
  return (
    <footer className="ftr">
      <div className="container ftr-inner">
        <a href="https://kaicorplabs.com" className="ftr-by">
          <img src="/kaicorp-mark.png" alt="" width={18} height={18} />
          <span>
            Built by <b>KaiCorp Labs</b>
          </span>
        </a>
        {links && (
          <nav className="ftr-nav" aria-label="Other services">
            {SERVICES.map((service) =>
              service.slug === "docdrop" ? (
                <span key={service.slug} aria-current="page">
                  {service.name}
                </span>
              ) : (
                <a key={service.slug} href={service.url}>
                  {service.name}
                </a>
              )
            )}
          </nav>
        )}
      </div>
    </footer>
  );
}
