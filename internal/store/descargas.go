package store

import (
	"sync"
	"time"
)

// La contabilidad de descargas, que es la parte más fácil de romper sin que se
// note y la que peor se nota cuando se rompe.
//
// UNA DESCARGA CUENTA CUANDO SE HA ENTREGADO, no cuando se ha pedido. Se
// contaba al llegar la petición, y el primer envío cifrado real enseñó por qué
// eso está mal: el teléfono de quien recibía se trajo el bulto, no consiguió
// convertirlo en un fichero guardado, y la única descarga que permitía el
// enlace se había gastado — para un fichero que nadie tenía.
//
// Lo que una petición en vuelo SÍ ocupa es su plaza contra el límite: mientras
// se está enviando la última descarga permitida, una segunda petición se
// rechaza. Si no, dos personas abriendo el enlace a la vez se llevarían las dos
// un fichero que permitía una. La plaza caduca sola, para que una conexión
// atascada para siempre no bloquee el enlace para siempre.

const vidaPlaza = 2 * time.Hour

type plaza struct{ en time.Time }

// enVuelo cuenta las plazas vivas de un id y purga las caducadas.
// Se llama con vueloMu tomado.
func (s *Store) enVuelo(id string, ahora time.Time) int {
	vivas := s.vuelo[id][:0]
	for _, p := range s.vuelo[id] {
		if ahora.Sub(p.en) < vidaPlaza {
			vivas = append(vivas, p)
		}
	}
	if len(vivas) == 0 {
		delete(s.vuelo, id)
		return 0
	}
	s.vuelo[id] = vivas
	return len(vivas)
}

// Reclamo es una descarga admitida. `Hecho` se llama exactamente una vez.
type Reclamo struct {
	Meta Meta

	s     *Store
	id    string
	sitio *plaza // nil cuando el reclamo no contaba (vista previa o continuación)
	una   sync.Once
}

// Reclamar pide una plaza de descarga, serializado por id.
//
// Con `contar` en false sólo comprueba disponibilidad: es lo que hacen las
// vistas previas y las continuaciones por rango, que pertenecen a una descarga
// que ya se contó por su cuenta.
func (s *Store) Reclamar(id string, contar bool) (*Reclamo, error) {
	soltar := s.candados.tomar(id)
	defer soltar()

	ahora := s.ahora()
	m := s.LeerMeta(id)
	if m == nil {
		return nil, ErrNoEncontrado
	}
	if motivo := m.Motivo(ahora); motivo != "" {
		if !m.EsLapida() {
			_ = s.Quemar(id, motivo)
		}
		return nil, errorDeMotivo(motivo)
	}
	if !contar {
		return &Reclamo{Meta: *m, s: s, id: id}, nil
	}

	s.vueloMu.Lock()
	if m.MaxDownloads > 0 && m.DownloadCount+s.enVuelo(id, ahora) >= m.MaxDownloads {
		s.vueloMu.Unlock()
		return nil, ErrAgotado
	}
	sitio := &plaza{en: ahora}
	s.vuelo[id] = append(s.vuelo[id], sitio)
	s.vueloMu.Unlock()

	return &Reclamo{Meta: *m, s: s, id: id, sitio: sitio}, nil
}

func errorDeMotivo(motivo string) error {
	if motivo == MotivoCaducado {
		return ErrCaducado
	}
	return ErrAgotado
}

// Hecho cierra el reclamo. `entregado` dice si salió el último byte: sólo una
// transferencia entregada cuenta. Una cortada suelta su plaza sin contar.
//
// Se puede llamar más de una vez sin efecto; lo hace el camino de error de los
// manejadores, que no siempre sabe si el flujo llegó a terminar.
func (r *Reclamo) Hecho(entregado bool) error {
	if r == nil {
		return nil
	}
	var err error
	r.una.Do(func() {
		if r.sitio == nil {
			return // no contaba: no hay plaza que soltar ni nada que escribir
		}
		soltar := r.s.candados.tomar(r.id)
		defer soltar()
		defer r.liberarPlaza()

		if !entregado {
			return
		}
		fresca := r.s.LeerMeta(r.id)
		if fresca == nil || fresca.EsLapida() {
			return
		}
		fresca.DownloadCount++
		if err = r.s.EscribirMeta(fresca); err != nil {
			return
		}
		if fresca.Agotado() {
			err = r.s.Quemar(r.id, MotivoAgotado)
		}
	})
	return err
}

// liberarPlaza se llama con el candado del id puesto: la reserva se conserva
// hasta que su actualización del contador está escrita.
func (r *Reclamo) liberarPlaza() {
	r.s.vueloMu.Lock()
	defer r.s.vueloMu.Unlock()
	resto := r.s.vuelo[r.id][:0]
	for _, p := range r.s.vuelo[r.id] {
		if p != r.sitio {
			resto = append(resto, p)
		}
	}
	if len(resto) == 0 {
		delete(r.s.vuelo, r.id)
		return
	}
	r.s.vuelo[r.id] = resto
}

// ─── Continuaciones de transferencia ────────────────────────────────
//
// Una respuesta completa paga las continuaciones por rango de ESE cliente. Una
// interrumpida no cuenta y no puede regalar continuaciones: su reintento tiene
// que pedir y liquidar su propia plaza.
//
// La comprobación era «el rango no empieza en el byte 0», que es algo que
// escoge quien llama: `Range: bytes=1-` devolvía todo menos el primer byte y
// `Range: bytes=-<tamaño>` el fichero ENTERO, las dos sin contar y tantas veces
// como se pidiera. El límite de descargas era decorativo para cualquiera que
// tuviera el enlace.
//
// Aviso que sigue vigente: la clave lleva el cliente, y sin un proxy delante
// todos los clientes son el mismo ("direct", ver httpapi/limites.go). En ese
// despliegue las continuaciones se comparten, que es el mismo punto ciego que
// ya tiene el limitador de peticiones.

const vidaContinuacion = time.Hour

func claveTransferencia(id, cliente string) string { return id + "\x00" + cliente }

// RegistrarTransferencia apunta una transferencia contabilizada, para reconocer
// las continuaciones de ese cliente.
func (s *Store) RegistrarTransferencia(id, cliente string) {
	ahora := s.ahora()
	s.vueloMu.Lock()
	defer s.vueloMu.Unlock()
	// Purga perezosa, para que el mapa no crezca con cada descarga suelta.
	if ahora.Sub(s.ultimaPurga) > vidaContinuacion {
		s.ultimaPurga = ahora
		for k, en := range s.transferencias {
			if ahora.Sub(en) > vidaContinuacion {
				delete(s.transferencias, k)
			}
		}
	}
	s.transferencias[claveTransferencia(id, cliente)] = ahora
}

// TransferenciaReanudada dice si un rango continúa una transferencia que este
// cliente ya pagó.
func (s *Store) TransferenciaReanudada(id, cliente string) bool {
	s.vueloMu.Lock()
	defer s.vueloMu.Unlock()
	en, hay := s.transferencias[claveTransferencia(id, cliente)]
	return hay && s.ahora().Sub(en) < vidaContinuacion
}
