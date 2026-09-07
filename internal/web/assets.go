// Package web lleva dentro del binario lo que construye vite: un solo fichero
// que desplegar, sin volumen de estáticos ni servidor delante repartiendo.
package web

import (
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var incrustado embed.FS

// Recursos son los nombres con hash de esta construcción. Van en el HTML, y por
// eso se leen del manifiesto en vez de escribirse a mano: un nombre desfasado
// da una página en blanco sin decir por qué.
type Recursos struct {
	JS  string
	CSS []string
}

type entrada struct {
	File    string   `json:"file"`
	CSS     []string `json:"css"`
	IsEntry bool     `json:"isEntry"`
}

// Cargar devuelve recursos vacíos si no hay construcción: el binario sigue
// sirviendo la API, que es lo que permite probarlo sin pasar por vite.
func Cargar() (Recursos, error) {
	crudo, err := incrustado.ReadFile("dist/.vite/manifest.json")
	if err != nil {
		return Recursos{}, nil
	}
	var manifiesto map[string]entrada
	if err := json.Unmarshal(crudo, &manifiesto); err != nil {
		return Recursos{}, err
	}
	for _, e := range manifiesto {
		if e.IsEntry {
			return Recursos{JS: "/" + e.File, CSS: conBarra(e.CSS)}, nil
		}
	}
	return Recursos{}, nil
}

func conBarra(rutas []string) []string {
	salida := make([]string, 0, len(rutas))
	for _, r := range rutas {
		salida = append(salida, "/"+r)
	}
	return salida
}

// Estaticos sirve lo construido y, aparte, lo que vite copia de `public/`: el
// logo, la imagen de OpenGraph, los iconos de la PWA y el service worker.
//
// Los de `/assets/` llevan hash del contenido y se cachean para siempre. Los de
// la raíz NO: su nombre no cambia con el contenido, y un `/og.jpg` inmutable en
// el navegador de alguien es una tarjeta de enlace desfasada para siempre.
func Estaticos() (http.Handler, error) {
	sub, err := fs.Sub(incrustado, "dist")
	if err != nil {
		return nil, err
	}
	sistema := http.FS(sub)
	ficheros := http.FileServer(sistema)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ruta := strings.TrimPrefix(r.URL.Path, "/")
		// El manifiesto es de la construcción, no del sitio.
		if strings.HasPrefix(r.URL.Path, "/.vite/") || ruta == "" {
			http.NotFound(w, r)
			return
		}
		// Sin listados de directorio: FileServer los pinta por defecto, y aquí
		// eso sería enumerar los recursos del build.
		f, err := sistema.Open(r.URL.Path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		info, err := f.Stat()
		f.Close()
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		ficheros.ServeHTTP(w, r)
	}), nil
}
