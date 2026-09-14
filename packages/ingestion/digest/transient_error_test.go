package digest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// TestTransientDatabaseErrorClassification pins which publication failures
// leave a run written for the scheduler to revalidate and which fail it.
func TestTransientDatabaseErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "serialization failure", err: &pgconn.PgError{Code: "40001"}, want: true},
		{name: "deadlock wrapped by a caller", err: fmt.Errorf("finalize ledger: %w", &pgconn.PgError{Code: "40P01"}), want: true},
		{name: "connection failure", err: &pgconn.PgError{Code: "08006"}, want: true},
		{name: "protocol violation reproduces on retry", err: &pgconn.PgError{Code: "08P01"}, want: false},
		{name: "too many connections", err: &pgconn.PgError{Code: "53300"}, want: true},
		{name: "admin shutdown", err: &pgconn.PgError{Code: "57P01"}, want: true},
		{name: "dropped connection at commit", err: fmt.Errorf("commit digest publication: %w", io.EOF), want: true},
		{name: "truncated response", err: io.ErrUnexpectedEOF, want: true},
		{name: "deadline", err: context.DeadlineExceeded, want: true},
		{name: "raised by a trigger", err: &pgconn.PgError{Code: "P0001"}, want: false},
		{name: "undefined column", err: &pgconn.PgError{Code: "42703"}, want: false},
		{name: "validation failure", err: errors.New("unknown digest candidate"), want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := transientDatabaseError(tc.err); got != tc.want {
				t.Fatalf("transientDatabaseError(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
