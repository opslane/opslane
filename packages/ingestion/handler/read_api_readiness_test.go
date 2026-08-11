package handler

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/db"
)

func readinessPtr(value string) *string { return &value }

func TestToIncidentJSONGatesUnverifiedInvestigationOutput(t *testing.T) {
	rootCause := "placeholder"
	mitigation := "change the handler"

	tests := []struct {
		name          string
		readiness     *string
		wantCause     bool
		wantReadiness *string
	}{
		{name: "ineligible", readiness: readinessPtr("ineligible"), wantCause: false, wantReadiness: readinessPtr("ineligible")},
		{name: "pending", readiness: readinessPtr("pending"), wantCause: false, wantReadiness: readinessPtr("pending")},
		{name: "eligible", readiness: readinessPtr("eligible"), wantCause: true, wantReadiness: readinessPtr("eligible")},
		{name: "legacy absent row", readiness: nil, wantCause: true, wantReadiness: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			inc := toIncidentJSON(db.ErrorGroup{
				RootCause:              &rootCause,
				SuggestedMitigation:    &mitigation,
				InvestigationReadiness: tt.readiness,
			})
			if got := inc.RootCause != nil; got != tt.wantCause {
				t.Fatalf("RootCause present = %v, want %v", got, tt.wantCause)
			}
			if got := inc.SuggestedMitigation != nil; got != tt.wantCause {
				t.Fatalf("SuggestedMitigation present = %v, want %v", got, tt.wantCause)
			}
			if inc.InvestigationReadiness != tt.wantReadiness &&
				(inc.InvestigationReadiness == nil || tt.wantReadiness == nil || *inc.InvestigationReadiness != *tt.wantReadiness) {
				t.Fatalf("InvestigationReadiness = %v, want %v", inc.InvestigationReadiness, tt.wantReadiness)
			}
		})
	}
}
