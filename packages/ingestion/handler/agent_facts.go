package handler

import (
	"net/http"

	"github.com/opslane/opslane/packages/ingestion/db"
)

// agentFacts is filled in by Task 4. The empty struct keeps Task 3 buildable.
type agentFacts struct{}

func (d *Dependencies) agentSessionFacts(_ *http.Request, _ *db.AgentSession) agentFacts {
	return agentFacts{}
}
