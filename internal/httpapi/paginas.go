package httpapi

import (
	"html/template"
	"net/http"
	"strconv"
	"strings"
)

const (
	tituloPorDefecto = "DocDrop — send the whole file, then let it disappear"
	descripcion      = "Multi-gigabyte transfers with nothing recompressed: uploads resume after a dropped connection, and links delete themselves when you say so. Self-hosted and open source."
	textoAlternativo = "DocDrop: large files uploading, each with its expiry"
)

// datos es todo lo que la plantilla necesita. Va escapado por contexto con
// html/template: ni una variable de entorno rara ni un nombre con comillas
// pueden salirse de su atributo.
type datos struct {
	Pagina      string
	Titulo      string
	Descripcion string
	Canonica    string
	Imagen      string
	NoIndex     bool
	Nonce       string
	JS          string
	CSS         []string
	// Lo que el navegador necesita saber y no puede deducir.
	Email         string
	CuentaURL     string
	AltaURL       string
	Footer        bool
	FicheroID     string
	TokenInvitado string
	Trozo         string
	MaxFichero    string
	MaxTotal      string
	TTLInvitado   string
}

func (s *Server) documento(w http.ResponseWriter, r *http.Request, d datos) {
	d.Nonce = nonceDe(r)
	d.JS, d.CSS = s.recursos.JS, s.recursos.CSS
	d.CuentaURL = s.cfg.AccountURL
	d.AltaURL = s.cfg.EnrollURL
	d.Footer = s.cfg.EnlacesPie
	d.Trozo = strconv.FormatInt(s.subidas.Trozo(), 10)
	d.MaxFichero = strconv.FormatInt(s.almacen.MaxFichero(), 10)
	d.MaxTotal = strconv.FormatInt(s.almacen.MaxTotal(), 10)
	d.TTLInvitado = strconv.Itoa(ttlFicheroInvitado)
	if d.Titulo == "" {
		d.Titulo = tituloPorDefecto
	}
	if d.Descripcion == "" {
		d.Descripcion = descripcion
	}
	if d.Canonica != "" {
		d.Imagen = s.origenPublico() + "/og.jpg"
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	// El HTML es privado: enseña el correo de quien entra y decide si ve el
	// panel o la portada. El valor es el mismo que emite la versión de Node.
	h.Set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate")
	w.WriteHeader(http.StatusOK)
	_ = plantilla.Execute(w, d)
}

// ttlFicheroInvitado es lo que dura lo que sube un invitado. Fijo y no elegido:
// un invitado está entregando algo, no gestionando almacenamiento. Tiene que
// quedar por debajo del techo que aplica el servidor.
const ttlFicheroInvitado = 24

func (s *Server) origenPublico() string {
	if s.cfg.PublicHost == "" {
		return ""
	}
	return "https://" + s.cfg.PublicHost
}

// canonica devuelve la URL absoluta de una ruta, o "" si no hay origen público
// configurado: una canónica apuntando a localhost es peor que ninguna.
func (s *Server) canonica(ruta string) string {
	if s.cfg.PublicHost == "" {
		return ""
	}
	return s.origenPublico() + ruta
}

// GET / — la puerta, decidida en el servidor: quien no entra ve la portada y
// quien tiene sesión va directo a sus ficheros. Antes redirigía a un formulario
// de entrada, que para un desconocido es una puerta cerrada sin explicación de
// lo que hay detrás.
func (s *Server) paginaInicio(w http.ResponseWriter, r *http.Request) {
	d := datos{Pagina: "landing", Canonica: s.canonica("/")}
	if u := s.usuarioActual(r); u != nil {
		d.Pagina, d.Email = "dashboard", u.Email
	}
	s.documento(w, r, d)
}

// GET /d/{id} — la página de descarga.
//
// Nunca puede llegar a un índice: el identificador de la URL ES la credencial
// —72 bits que cualquiera que los tenga puede usar—, así que un rastreador que
// encuentre uno y lo publique regala el fichero al mundo.
func (s *Server) paginaDescarga(w http.ResponseWriter, r *http.Request) {
	// El id va tal cual, sin filtrar: uno inválido tiene que llegar al cliente
	// para que pregunte y reciba el mismo «no existe» que en la versión de
	// Node. Filtrarlo aquí cambiaría la página que ve quien copió mal un
	// enlace. Sale escapado por `html/template`, y la ruta es de un solo
	// segmento, así que no hay nada que se pueda colar por ahí.
	s.documento(w, r, datos{Pagina: "download", FicheroID: r.PathValue("id"), NoIndex: true})
}

// GET /guest/{token} — la página del invitado. Tampoco puede indexarse: el
// token de la ruta es lo que concede la subida, así que uno indexado es una
// puerta abierta con cuenta atrás.
func (s *Server) paginaInvitado(w http.ResponseWriter, r *http.Request) {
	// Igual que la de descarga: el token va tal cual y quien decide es la API.
	s.documento(w, r, datos{Pagina: "guest", TokenInvitado: r.PathValue("token"), NoIndex: true})
}

// POST /share — el objetivo declarado en el manifiesto para el menú «Compartir»
// del sistema.
//
// Normalmente esta ruta no se ejecuta nunca: el service worker intercepta el
// POST, guarda el fichero y redirige a la página. Esto es sólo la red de
// seguridad para cuando el worker todavía no está activo, y así compartir no
// acaba en un 405 sin explicación.
func (s *Server) compartir(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/?shared=error", http.StatusSeeOther)
}

func (s *Server) compartirGet(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}

// GET /robots.txt — byte a byte lo que sirve la versión de Node.
//
// `/d/` y `/guest/` se prohíben porque el identificador de esas URLs es la
// credencial: 72 bits aleatorios que conceden una descarga, o un token que
// concede una subida. La portada, que explica el producto, es lo único aquí que
// merece indexarse.
func (s *Server) robots(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder
	b.WriteString("User-Agent: *\nAllow: /\nDisallow: /d/\nDisallow: /guest/\nDisallow: /api/\nDisallow: /share\n")
	if origen := s.origenPublico(); origen != "" {
		b.WriteString("\nHost: " + origen + "\nSitemap: " + origen + "/sitemap.xml\n")
	}
	texto(w, "text/plain; charset=utf-8", b.String())
}

// GET /sitemap.xml — sólo la portada: todas las demás rutas llevan una
// credencial en el camino. Sin origen público no hay nada absoluto que
// escribir, así que sale vacío en vez de mal.
func (s *Server) sitemap(w http.ResponseWriter, r *http.Request) {
	cuerpo := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n"
	if origen := s.origenPublico(); origen != "" {
		cuerpo += "<url>\n<loc>" + origen + "/</loc>\n<changefreq>monthly</changefreq>\n<priority>1</priority>\n</url>\n"
	}
	cuerpo += "</urlset>\n"
	texto(w, "application/xml", cuerpo)
}

// GET /manifest.webmanifest — el manifiesto de la PWA.
//
// `share_target` es lo que de verdad cambia el uso diario: hace que DocDrop
// salga en el menú «Compartir» del teléfono, así que un vídeo se manda desde la
// galería sin abrir el navegador ni buscar el fichero.
func (s *Server) manifiesto(w http.ResponseWriter, r *http.Request) {
	texto(w, "application/manifest+json", manifiestoJSON)
}

const manifiestoJSON = `{"name":"DocDrop — Share files","short_name":"DocDrop","description":"Upload a file, share the link. It self-destructs.","start_url":"/","scope":"/","display":"standalone","orientation":"portrait-primary","background_color":"#16161f","theme_color":"#16161f","categories":["utilities","productivity"],"icons":[{"src":"/icons/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any"},{"src":"/icons/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any"},{"src":"/icons/icon-maskable-512.png","sizes":"512x512","type":"image/png","purpose":"maskable"}],"share_target":{"action":"/share","method":"POST","enctype":"multipart/form-data","params":{"files":[{"name":"file","accept":["*/*"]}]}}}`

func texto(w http.ResponseWriter, tipo, cuerpo string) {
	w.Header().Set("Content-Type", tipo)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write([]byte(cuerpo))
}

// GET /healthz — la sonda del contenedor.
//
// Ruta propia y no `/api/info/<id>` como hacía la versión de Node: aquélla pasa
// por el limitador de peticiones y comparte cupo con el tráfico real cuando no
// hay proxy delante. Aquí no se escribe nada, no se recorre el almacén y no se
// cuenta contra ningún límite.
func (s *Server) salud(w http.ResponseWriter, r *http.Request) {
	texto(w, "text/plain; charset=utf-8", "ok\n")
}

// estaticoO404 sirve lo que construyó vite y lo que vite copió de `public/`.
// Todo lo demás es 404: NO hay respaldo de SPA, porque una ruta de API que no
// existe tiene que seguir siendo 404 y no un 200 con HTML.
func (s *Server) estaticoO404(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		errorJSON(w, http.StatusNotFound, "Not found")
		return
	}
	s.estaticos.ServeHTTP(w, r)
}

// El documento. Lo compone Go con la sesión ya resuelta y deja en `#app` lo que
// el navegador no puede deducir; React monta la pantalla que corresponda.
//
// El script del tema va en línea y con el nonce: es lo que evita el fogonazo
// del tema equivocado antes de que React monte. Lee la misma clave de
// localStorage que usa next-themes ("theme") y aplica el mismo criterio
// —defaultTheme "dark", sistema si está guardado "system"—, así que cuando
// React arranca ya coincide y no repinta.
var plantilla = template.Must(template.New("doc").Parse(
	`<!doctype html><html lang="en" class="antialiased"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script nonce="{{.Nonce}}">try{var t=localStorage.getItem("theme")||"dark";if(t==="system"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.classList.add(t);document.documentElement.style.colorScheme=t}catch(e){document.documentElement.classList.add("dark")}</script>
<meta name="theme-color" content="#fbfbfe" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#16161f" media="(prefers-color-scheme: dark)">
<title>{{.Titulo}}</title>
<meta name="description" content="{{.Descripcion}}">
{{if .NoIndex}}<meta name="robots" content="noindex, nofollow">
{{end}}<link rel="manifest" href="/manifest.webmanifest">
{{if .Canonica}}<link rel="canonical" href="{{.Canonica}}">
<meta property="og:url" content="{{.Canonica}}">
{{end}}<meta property="og:title" content="{{.Titulo}}">
<meta property="og:description" content="{{.Descripcion}}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="DocDrop">
<meta property="og:locale" content="en_US">
{{if .Imagen}}<meta property="og:image" content="{{.Imagen}}">
<meta property="og:image:width" content="760">
<meta property="og:image:height" content="475">
<meta property="og:image:alt" content="` + textoAlternativo + `">
{{end}}<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/icons/icon-512.png" sizes="512x512" type="image/png">
<link rel="preload" href="/kaicorp-mark.png" as="image">
{{range .CSS}}<link rel="stylesheet" href="{{.}}">
{{end}}</head>
<body class="min-h-dvh flex flex-col">
<div id="app" data-page="{{.Pagina}}"{{if .Email}} data-email="{{.Email}}"{{end}}{{if .FicheroID}} data-file-id="{{.FicheroID}}"{{end}}{{if .TokenInvitado}} data-guest-token="{{.TokenInvitado}}"{{end}}{{if .CuentaURL}} data-account-url="{{.CuentaURL}}"{{end}}{{if .AltaURL}} data-enroll-url="{{.AltaURL}}"{{end}}{{if .Footer}} data-footer-links="on"{{end}} data-chunk-size="{{.Trozo}}" data-max-file-bytes="{{.MaxFichero}}" data-max-total-bytes="{{.MaxTotal}}" data-guest-ttl-hours="{{.TTLInvitado}}"></div>
{{if .JS}}<script type="module" nonce="{{.Nonce}}" src="{{.JS}}"></script>{{end}}
</body></html>
`))
