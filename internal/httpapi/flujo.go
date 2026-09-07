package httpapi

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
)

// Copia en flujo, con memoria acotada y cancelable.
//
// NUNCA se carga un fichero en memoria: el contenedor tiene 1 GiB y el límite
// por fichero son 10 GB. La versión de Node llegó a usar `request.formData()`,
// que materializa el cuerpo entero, y el proceso moría mucho antes del límite
// anunciado.
//
// El búfer es pequeño a propósito y sale de una reserva compartida: lo que
// decide el rendimiento aquí es el disco y la red, no el tamaño del búfer, y
// con transferencias simultáneas un búfer grande por petición sí se nota en la
// memoria del contenedor.

const tamBuffer = 256 * 1024

var reserva = sync.Pool{New: func() any { b := make([]byte, tamBuffer); return &b }}

var errDemasiadoGrande = errors.New("demasiado grande")

// copiar mueve como mucho `tope` bytes y se corta si llegan más. Comprueba la
// cancelación entre trozos, que es lo que permite que una parada ordenada
// aborte una transferencia larga en vez de esperarla.
func copiar(ctx context.Context, destino io.Writer, origen io.Reader, tope int64) (int64, error) {
	b := reserva.Get().(*[]byte)
	defer reserva.Put(b)
	buf := *b

	var total int64
	for {
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		default:
		}
		n, err := origen.Read(buf)
		if n > 0 {
			if tope >= 0 && total+int64(n) > tope {
				// Se escribe lo que cabe y se corta: quien mintió en
				// Content-Length no obtiene más sitio del reservado.
				sobra := tope - total
				if sobra > 0 {
					if _, werr := destino.Write(buf[:sobra]); werr != nil {
						return total, werr
					}
					total += sobra
				}
				return total, errDemasiadoGrande
			}
			escritos, werr := destino.Write(buf[:n])
			total += int64(escritos)
			if werr != nil {
				return total, werr
			}
		}
		if err == io.EOF {
			return total, nil
		}
		if err != nil {
			return total, err
		}
	}
}

// escritorEn escribe en un desplazamiento fijo del fichero, que es lo que
// permite recibir los trozos de una subida en cualquier orden sin ensamblar
// nada después.
type escritorEn struct {
	f   *os.File
	pos int64
}

func (e *escritorEn) Write(p []byte) (int, error) {
	n, err := e.f.WriteAt(p, e.pos)
	e.pos += int64(n)
	return n, err
}
