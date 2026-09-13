package auth

import (
	"crypto/hmac"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// TicketFixIntent authorizes one explicit digest action after the reader signs
// in. It is not an access token; admission also checks the live attempt lineage.
type TicketFixIntent struct {
	ProjectID       string `json:"projectId"`
	IncidentID      string `json:"incidentId"`
	TicketID        string `json:"ticketId"`
	Generation      int    `json:"generation"`
	LatestAttemptID string `json:"latestAttemptId"`
	ExpiresAt       int64  `json:"exp"`
}

const ticketFixPurpose = "ticket-fix"

var errTicketFixIntent = errors.New("invalid or expired fix intent")

func SignTicketFixIntent(secret []byte, claims TicketFixIntent) (string, error) {
	if len(secret) < 32 || claims.ProjectID == "" || claims.IncidentID == "" || claims.TicketID == "" || claims.Generation < 1 || claims.ExpiresAt <= 0 {
		return "", errTicketFixIntent
	}
	payload, err := json.Marshal(struct {
		Purpose string `json:"purpose"`
		TicketFixIntent
	}{ticketFixPurpose, claims})
	if err != nil {
		return "", err
	}
	encoded := base64URLEncode(payload)
	return encoded + "." + base64URLEncode(hmacSHA256(secret, []byte(ticketFixPurpose+"|"+encoded))), nil
}

func VerifyTicketFixIntent(secret []byte, token string, now time.Time) (*TicketFixIntent, error) {
	if len(secret) < 32 || len(token) > 4096 {
		return nil, errTicketFixIntent
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, errTicketFixIntent
	}
	signature, err := base64URLDecode(parts[1])
	if err != nil || !hmac.Equal(signature, hmacSHA256(secret, []byte(ticketFixPurpose+"|"+parts[0]))) {
		return nil, errTicketFixIntent
	}
	payload, err := base64URLDecode(parts[0])
	if err != nil {
		return nil, errTicketFixIntent
	}
	var decoded struct {
		Purpose string `json:"purpose"`
		TicketFixIntent
	}
	if json.Unmarshal(payload, &decoded) != nil || decoded.Purpose != ticketFixPurpose || decoded.ProjectID == "" || decoded.IncidentID == "" || decoded.TicketID == "" || decoded.Generation < 1 || decoded.ExpiresAt <= now.Unix() {
		return nil, errTicketFixIntent
	}
	return &decoded.TicketFixIntent, nil
}
