package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func nuevo(t *testing.T, total int64) (*Store, *time.Time) {
	t.Helper()
	reloj := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)
	s, err := Open(Config{Dir: t.TempDir(), MaxTotal: total, Ahora: func() time.Time { return reloj }})
	if err != nil {
		t.Fatal(err)
	}
	return s, &reloj
}

func ficha(t *testing.T, s *Store, id string, bytes int, max int, vida time.Duration) {
	t.Helper()
	if err := s.CrearEntrada(id); err != nil {
		t.Fatal(err)
	}
	blob, _ := s.RutaBlob(id)
	if err := os.WriteFile(blob, make([]byte, bytes), 0o640); err != nil {
		t.Fatal(err)
	}
	ahora := s.Ahora()
	m := &Meta{ID: id, OriginalName: "x.bin", Size: int64(bytes), MimeType: "application/octet-stream",
		UploadedAt: ahora.UnixMilli(), ExpiresAt: ahora.Add(vida).UnixMilli(), MaxDownloads: max}
	if err := s.EscribirMeta(m); err != nil {
		t.Fatal(err)
	}
	s.InvalidarUsado()
}

// El JSON tiene que llevar los contadores aunque valgan cero: si faltaran, el
// Node de la vuelta atrás haría `undefined++` y el límite dejaría de existir.
func TestMetaConservaLosCeros(t *testing.T) {
	s, _ := nuevo(t, PorDefectoMaxTotal)
	ficha(t, s, "aaaaaaaaaaaa", 4, 0, time.Hour)

	ruta, _ := s.RutaMeta("aaaaaaaaaaaa")
	datos, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatal(err)
	}
	var bruto map[string]any
	if err := json.Unmarshal(datos, &bruto); err != nil {
		t.Fatal(err)
	}
	for _, campo := range []string{"id", "originalName", "size", "mimeType", "uploadedAt", "expiresAt", "downloadCount", "maxDownloads"} {
		if _, hay := bruto[campo]; !hay {
			t.Errorf("falta el campo obligatorio %q en %s", campo, datos)
		}
	}
	for _, campo := range []string{"uploadedBy", "owner", "encrypted", "burnedAt", "burnedReason"} {
		if _, hay := bruto[campo]; hay {
			t.Errorf("el opcional %q no debe aparecer cuando no aplica", campo)
		}
	}
}

func TestDescargaCuentaAlEntregar(t *testing.T) {
	s, _ := nuevo(t, PorDefectoMaxTotal)
	ficha(t, s, "bbbbbbbbbbbb", 4, 2, time.Hour)

	r, err := s.Reclamar("bbbbbbbbbbbb", true)
	if err != nil {
		t.Fatal(err)
	}
	if m := s.LeerMeta("bbbbbbbbbbbb"); m.DownloadCount != 0 {
		t.Fatalf("el contador se movió al reclamar: %d", m.DownloadCount)
	}
	// Cortada: no cuenta y suelta la plaza.
	if err := r.Hecho(false); err != nil {
		t.Fatal(err)
	}
	if m := s.LeerMeta("bbbbbbbbbbbb"); m.DownloadCount != 0 {
		t.Fatalf("una transferencia cortada contó: %d", m.DownloadCount)
	}

	r2, err := s.Reclamar("bbbbbbbbbbbb", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := r2.Hecho(true); err != nil {
		t.Fatal(err)
	}
	if m := s.LeerMeta("bbbbbbbbbbbb"); m.DownloadCount != 1 {
		t.Fatalf("una transferencia entregada no contó: %d", m.DownloadCount)
	}
}

// Mientras se envía la última descarga permitida, la segunda petición se
// rechaza: la plaza en vuelo ocupa sitio contra el límite.
func TestPlazaEnVueloOcupaSitio(t *testing.T) {
	s, _ := nuevo(t, PorDefectoMaxTotal)
	ficha(t, s, "cccccccccccc", 4, 1, time.Hour)

	r, err := s.Reclamar("cccccccccccc", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reclamar("cccccccccccc", true); err != ErrAgotado {
		t.Fatalf("la segunda petición debería agotarse, dio %v", err)
	}
	// Una vista previa sí puede pasar: no cuenta ni ocupa.
	if _, err := s.Reclamar("cccccccccccc", false); err != nil {
		t.Fatalf("la vista previa no debería bloquearse: %v", err)
	}
	if err := r.Hecho(true); err != nil {
		t.Fatal(err)
	}
	// Al agotarse queda como lápida con motivo, y el contenido desaparece.
	m := s.LeerMeta("cccccccccccc")
	if m == nil || m.BurnedReason != MotivoAgotado {
		t.Fatalf("no quedó lápida de agotado: %+v", m)
	}
	blob, _ := s.RutaBlob("cccccccccccc")
	if _, err := os.Stat(blob); !os.IsNotExist(err) {
		t.Fatal("el contenido debería estar borrado")
	}
}

// Dos peticiones simultáneas del último permiso: una entrega y cuenta, la otra
// se rechaza. Nunca cuentan las dos.
func TestUltimaDescargaConcurrente(t *testing.T) {
	s, _ := nuevo(t, PorDefectoMaxTotal)
	ficha(t, s, "dddddddddddd", 4, 1, time.Hour)

	var wg sync.WaitGroup
	var mu sync.Mutex
	admitidos := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.Reclamar("dddddddddddd", true)
			if err != nil {
				return
			}
			mu.Lock()
			admitidos++
			mu.Unlock()
			_ = r.Hecho(true)
		}()
	}
	wg.Wait()
	if admitidos != 1 {
		t.Fatalf("admitidos %d, esperaba 1", admitidos)
	}
	if m := s.LeerMeta("dddddddddddd"); m.DownloadCount != 1 {
		t.Fatalf("contador %d, esperaba 1", m.DownloadCount)
	}
}

// Dos subidas sobre el último hueco: sólo una entra.
func TestReservaExclusiva(t *testing.T) {
	s, _ := nuevo(t, 1000)
	var wg sync.WaitGroup
	var mu sync.Mutex
	entran := 0
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := s.Reservar(func(disponible int64) int64 {
				if disponible < 600 {
					return 0
				}
				return 600
			})
			if n > 0 {
				mu.Lock()
				entran++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if entran != 1 {
		t.Fatalf("entraron %d subidas de 600 B en 1000 B", entran)
	}
	if s.Reservados() != 600 {
		t.Fatalf("reservados %d", s.Reservados())
	}
	s.Soltar(600)
	if s.Reservados() != 0 {
		t.Fatalf("no se soltó la reserva: %d", s.Reservados())
	}
}

func TestLimpiezaQuemaYRetiraLapidas(t *testing.T) {
	s, reloj := nuevo(t, PorDefectoMaxTotal)
	ficha(t, s, "eeeeeeeeeeee", 8, 0, time.Hour)

	*reloj = reloj.Add(2 * time.Hour)
	if b := s.Limpiar(); len(b) != 1 {
		t.Fatalf("no se quemó el caducado: %v", b)
	}
	m := s.LeerMeta("eeeeeeeeeeee")
	if m == nil || m.BurnedReason != MotivoCaducado {
		t.Fatalf("no quedó lápida: %+v", m)
	}
	if s.Usado() != 0 {
		t.Fatalf("el espacio no se liberó: %d", s.Usado())
	}

	*reloj = reloj.Add(VidaLapida + time.Hour)
	if b := s.Limpiar(); len(b) != 1 {
		t.Fatalf("no se retiró la lápida: %v", b)
	}
	if s.LeerMeta("eeeeeeeeeeee") != nil {
		t.Fatal("la lápida sigue ahí")
	}
}

// Una subida troceada viva no se toca aunque no tenga ficha todavía.
func TestLimpiezaRespetaSesionViva(t *testing.T) {
	s, reloj := nuevo(t, PorDefectoMaxTotal)
	id := "ffffffffffff"
	if err := s.CrearEntrada(id); err != nil {
		t.Fatal(err)
	}
	dir, _ := s.DirEntrada(id)
	sesion := map[string]any{"sessionExpiresAt": reloj.Add(24 * time.Hour).UnixMilli()}
	datos, _ := json.Marshal(sesion)
	if err := os.WriteFile(filepath.Join(dir, "session.json"), datos, 0o640); err != nil {
		t.Fatal(err)
	}
	*reloj = reloj.Add(3 * time.Hour) // ya está fría, pero su sesión sigue viva
	if b := s.Limpiar(); len(b) != 0 {
		t.Fatalf("se borró una subida en curso: %v", b)
	}
}

func TestContinuacionesSoloTrasPagar(t *testing.T) {
	s, reloj := nuevo(t, PorDefectoMaxTotal)
	if s.TransferenciaReanudada("aaaaaaaaaaaa", "1.2.3.4") {
		t.Fatal("un cliente que no ha pagado no tiene continuación")
	}
	s.RegistrarTransferencia("aaaaaaaaaaaa", "1.2.3.4")
	if !s.TransferenciaReanudada("aaaaaaaaaaaa", "1.2.3.4") {
		t.Fatal("quien pagó debería continuar")
	}
	if s.TransferenciaReanudada("aaaaaaaaaaaa", "5.6.7.8") {
		t.Fatal("la continuación no es de otro cliente")
	}
	*reloj = reloj.Add(vidaContinuacion + time.Minute)
	if s.TransferenciaReanudada("aaaaaaaaaaaa", "1.2.3.4") {
		t.Fatal("la continuación debería haber caducado")
	}
}
