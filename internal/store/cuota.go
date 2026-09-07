package store

import (
	"os"
	"time"
)

// La cuota, que es lo que impide que subir hasta llenar el disco tumbe la
// máquina, y la reserva de espacio que la hace de verdad exclusiva.
//
// El candado se toma para COMPROBAR y APARTAR, y se suelta antes de transmitir.
// Sostenerlo durante toda la transferencia cierra la carrera —dos subidas
// viendo el mismo hueco libre— pero serializa el servicio entero: medido en la
// versión de Node, una subida de 1 MB tardaba 3,2 segundos esperando a otra que
// goteaba, y con un fichero de varios gigas desde una casa eso son minutos con
// todo el mundo parado.

const claveCuota = "quota" // no puede chocar con un id: los ids son hexadecimales

// Cuánto se conserva el recuento de disco. El panel pide el listado cada 10 s
// por pestaña abierta, y recorrer el almacén en cada petición es E/S tirada.
const vidaUsado = 5 * time.Second

func (s *Store) InvalidarUsado() {
	s.cuotaMu.Lock()
	s.usadoVale = false
	s.cuotaMu.Unlock()
}

// Usado son los bytes que ocupan los ficheros vivos. Las lápidas no cuentan
// porque ya no tienen contenido.
func (s *Store) Usado() int64 {
	ahora := s.ahora()
	s.cuotaMu.Lock()
	if s.usadoVale && ahora.Sub(s.usadoEn) < vidaUsado {
		v := s.usadoValor
		s.cuotaMu.Unlock()
		return v
	}
	s.cuotaMu.Unlock()

	var total int64
	for _, id := range s.ids() {
		blob, err := s.RutaBlob(id)
		if err != nil {
			continue
		}
		info, err := os.Stat(blob)
		if err != nil {
			// Sin blob (lápida o subida a medio empezar): no ocupa nada.
			continue
		}
		total += info.Size()
	}

	s.cuotaMu.Lock()
	s.usadoValor, s.usadoEn, s.usadoVale = total, ahora, true
	s.cuotaMu.Unlock()
	return total
}

// Reservados son los bytes prometidos a subidas que todavía están llegando.
func (s *Store) Reservados() int64 {
	s.cuotaMu.Lock()
	defer s.cuotaMu.Unlock()
	return s.reservados
}

func (s *Store) disponible() int64 {
	d := s.maxTotal - s.Usado() - s.Reservados()
	if d < 0 {
		return 0
	}
	return d
}

// Reservar aparta sitio para una subida que va a empezar.
//
// `pedir` recibe lo que queda libre de verdad —lo que hay en disco y lo que
// otras subidas ya han prometido— y devuelve cuánto quiere apartar, o 0 si no
// cabe. Lo que devuelve esta función hay que soltarlo SIEMPRE, pase lo que pase.
func (s *Store) Reservar(pedir func(disponible int64) int64) int64 {
	soltar := s.candados.tomar(claveCuota)
	defer soltar()

	s.InvalidarUsado()
	quiere := pedir(s.disponible())
	if quiere <= 0 {
		return 0
	}
	s.cuotaMu.Lock()
	s.reservados += quiere
	s.cuotaMu.Unlock()
	return quiere
}

// Soltar devuelve lo apartado. Va siempre en un `defer`: si no se suelta, el
// hueco queda reservado para siempre y la instancia se queda sin sitio sola.
func (s *Store) Soltar(bytes int64) {
	if bytes <= 0 {
		return
	}
	s.cuotaMu.Lock()
	s.reservados -= bytes
	if s.reservados < 0 {
		s.reservados = 0
	}
	// Lo que llegó a escribirse ya está en disco: el siguiente tiene que verlo.
	s.usadoVale = false
	s.cuotaMu.Unlock()
}

// ConPresupuesto ejecuta `crear` con el candado de cuota puesto: la
// comprobación y la creación de la entrada pasan a ser una sola operación.
//
// Antes eran dos pasos con un recuento cacheado en medio, así que varias
// subidas simultáneas leían el mismo total viejo y todas reservaban el hueco
// entero: cinco subidas de 100 MB cabían en un almacén de 100 MB.
func (s *Store) ConPresupuesto(crear func(disponible int64) error) error {
	soltar := s.candados.tomar(claveCuota)
	defer soltar()

	s.InvalidarUsado()
	err := crear(s.disponible())
	// Una entrada a medio crear también ocupa: el siguiente tiene que verla.
	s.InvalidarUsado()
	return err
}

// ConCuota crea sólo si `bytes` cabe. El booleano dice si cupo.
func (s *Store) ConCuota(bytes int64, crear func() error) (bool, error) {
	cupo := false
	err := s.ConPresupuesto(func(disponible int64) error {
		if bytes > disponible {
			return nil
		}
		cupo = true
		return crear()
	})
	if err != nil {
		return false, err
	}
	return cupo, nil
}
