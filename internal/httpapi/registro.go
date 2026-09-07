package httpapi

import (
	"errors"
	"log"
)

// avisar es el registro del servicio. Nunca lleva contenido de nadie: ni
// nombres de fichero, ni tokens, ni correos.
func avisar(formato string, args ...any) { log.Printf(formato, args...) }

func errorEs(err, objetivo error) bool { return errors.Is(err, objetivo) }
