package auth

import (
	"testing"
	"time"
)

func TestTicketFixIntent(t *testing.T) {
	secret := []byte("ticket-intent-secret-at-least-32-bytes")
	now := time.Now()
	claims := TicketFixIntent{ProjectID: "project", IncidentID: "incident", TicketID: "ticket", Generation: 1, ExpiresAt: now.Add(time.Hour).Unix()}
	token, err := SignTicketFixIntent(secret, claims)
	if err != nil {
		t.Fatal(err)
	}
	got, err := VerifyTicketFixIntent(secret, token, now)
	if err != nil || *got != claims {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	for name, bad := range map[string]string{"tampered": token + "x", "malformed": "nope", "jwt": func() string { s, _ := SignAccessToken(secret, "user", "org", "email"); return s }()} {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyTicketFixIntent(secret, bad, now); err == nil {
				t.Fatal("accepted invalid intent")
			}
		})
	}
	if _, err := VerifyTicketFixIntent(secret, token, now.Add(time.Hour)); err == nil {
		t.Fatal("accepted expired intent")
	}
	if _, err := VerifyTicketFixIntent([]byte("different-secret-at-least-32-bytes"), token, now); err == nil {
		t.Fatal("accepted wrong key")
	}
	if _, err := SignTicketFixIntent(nil, claims); err == nil {
		t.Fatal("accepted empty key")
	}
}
