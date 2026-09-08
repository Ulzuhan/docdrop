package store

import (
	"testing"
	"time"
)

// Port of the old Node regression: equal timestamps do not identify a slot.
func TestLiberarUnaPlazaNoLiberaOtraDelMismoInstante(t *testing.T) {
	s, _ := nuevo(t, PorDefectoMaxTotal)
	const id = "abababababab"
	ficha(t, s, id, 4, 2, time.Hour)
	first, err := s.Reclamar(id, true)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Reclamar(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Hecho(false); err != nil {
		t.Fatal(err)
	}
	third, err := s.Reclamar(id, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reclamar(id, true); err != ErrAgotado {
		t.Fatalf("another reader borrowed the second slot: %v", err)
	}
	// Releasing the same handle twice must also leave the other readers alone.
	if err := first.Hecho(false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reclamar(id, true); err != ErrAgotado {
		t.Fatalf("duplicate release changed admission: %v", err)
	}
	if err := second.Hecho(true); err != nil {
		t.Fatal(err)
	}
	if err := third.Hecho(true); err != nil {
		t.Fatal(err)
	}
	m := s.LeerMeta(id)
	if m == nil || m.DownloadCount != 2 || m.BurnedReason != MotivoAgotado {
		t.Fatalf("incorrect final accounting: %+v", m)
	}
}
