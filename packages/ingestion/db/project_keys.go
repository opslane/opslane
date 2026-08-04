package db

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	ScopeIngest     = "ingest"
	ScopeSourcemaps = "sourcemaps"
)

const (
	prefixIngest     = "opslane_pk"
	prefixSourcemaps = "opslane_sk"
	keyIDBytes       = 16
	secretBytes      = 32
)

var (
	keyIDRe     = regexp.MustCompile(`^[a-z2-7]{26}$`)
	secretRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

	// ErrProjectKeyInvalid intentionally combines every unusable-credential
	// case so callers do not reveal which part of a credential was recognised.
	ErrProjectKeyInvalid = errors.New("invalid project key")
)

// MintedProjectKey contains the raw key only at creation time. The database
// stores SecretHash, never Raw.
type MintedProjectKey struct {
	ID          string
	KeyID       string
	Scope       string
	TokenPrefix string
	SecretHash  string
	Raw         string
}

type ParsedProjectKey struct {
	KeyID  string
	Secret string
	Scope  string
}

type ProjectKeyLookup struct {
	KeyID                   string
	ProjectID               string
	OrgID                   string
	Scope                   string
	AllowedOrigins          []string
	AllowPayloadEnvironment bool
}

func prefixForScope(scope string) (string, error) {
	switch scope {
	case ScopeIngest:
		return prefixIngest, nil
	case ScopeSourcemaps:
		return prefixSourcemaps, nil
	default:
		return "", fmt.Errorf("unknown key scope %q", scope)
	}
}

func scopeForPrefix(prefix string) (string, bool) {
	switch prefix {
	case prefixIngest:
		return ScopeIngest, true
	case prefixSourcemaps:
		return ScopeSourcemaps, true
	default:
		return "", false
	}
}

func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// NewProjectKey mints a credential. endpoint is the upload destination sealed
// into a source-map key: it is REQUIRED for ScopeSourcemaps and must be empty
// for every other scope. Making the pairing part of the signature is what keeps
// a bare sk unconstructable and stops a pk from ever growing a payload.
func NewProjectKey(scope, endpoint string) (*MintedProjectKey, error) {
	prefix, err := prefixForScope(scope)
	if err != nil {
		return nil, err
	}
	switch scope {
	case ScopeSourcemaps:
		if endpoint == "" {
			return nil, fmt.Errorf("sourcemaps keys require an endpoint")
		}
	default:
		if endpoint != "" {
			return nil, fmt.Errorf("endpoint is only valid for sourcemaps keys")
		}
	}

	idRaw := make([]byte, keyIDBytes)
	if _, err := rand.Read(idRaw); err != nil {
		return nil, fmt.Errorf("generate key id: %w", err)
	}
	secretRaw := make([]byte, secretBytes)
	if _, err := rand.Read(secretRaw); err != nil {
		return nil, fmt.Errorf("generate key secret: %w", err)
	}

	keyID := strings.ToLower(base32NoPad.EncodeToString(idRaw))
	secret := base64.RawURLEncoding.EncodeToString(secretRaw)
	raw := prefix + "_" + keyID + "_" + secret
	if scope == ScopeSourcemaps {
		canonical, err := CanonicalIngestURL(endpoint)
		if err != nil {
			return nil, err
		}
		payload, err := EncodeSKPayload(canonical, time.Now())
		if err != nil {
			return nil, err
		}
		raw += "_" + payload
	}
	return &MintedProjectKey{
		KeyID:       keyID,
		Scope:       scope,
		TokenPrefix: prefix,
		// The stored hash covers the secret alone: the payload is public
		// routing data and must not participate in authentication.
		SecretHash: HashSecret(secret),
		Raw:        raw,
	}, nil
}

// ParseProjectKey recognises the raw credential and, for source-map keys,
// validates any trailing endpoint payload. Every rejection returns the same
// opaque message so an attacker cannot learn which part was recognised; the
// reason tokens ParseSKPayload produces stay inside the codec.
func ParseProjectKey(raw string) (*ParsedProjectKey, error) {
	if len(raw) > MaxRawKeyLen {
		return nil, fmt.Errorf("malformed key")
	}
	// The secret and the payload both use base64url and may contain
	// underscores, so the fourth component is the entire remainder and the
	// secret is taken at its fixed width rather than by splitting again.
	parts := strings.SplitN(raw, "_", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("malformed key")
	}
	scope, ok := scopeForPrefix(parts[0] + "_" + parts[1])
	if !ok || !keyIDRe.MatchString(parts[2]) {
		return nil, fmt.Errorf("malformed key")
	}
	remainder := parts[3] // secret, optionally followed by "_" + payload
	if len(remainder) < secretLen {
		return nil, fmt.Errorf("malformed key")
	}
	secret := remainder[:secretLen]
	if !secretRe.MatchString(secret) {
		return nil, fmt.Errorf("malformed key")
	}
	switch {
	case len(remainder) == secretLen:
		// Bare key: still valid server-side for both scopes, because routing
		// to an endpoint is a client concern.
	case remainder[secretLen] != '_':
		return nil, fmt.Errorf("malformed key")
	default:
		payload := remainder[secretLen+1:]
		if scope != ScopeSourcemaps {
			return nil, fmt.Errorf("malformed key") // payload on a pk
		}
		if _, err := ParseSKPayload(payload); err != nil {
			return nil, fmt.Errorf("malformed key")
		}
	}
	return &ParsedProjectKey{KeyID: parts[2], Secret: secret, Scope: scope}, nil
}

func (q *Queries) CreateProjectKey(
	ctx context.Context,
	projectID, scope, label string,
	createdByUserID *string,
	endpoint string,
) (*MintedProjectKey, error) {
	minted, err := NewProjectKey(scope, endpoint)
	if err != nil {
		return nil, err
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO project_api_keys
		   (key_id, project_id, scope, token_prefix, secret_hash, label, created_by_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		minted.KeyID, projectID, minted.Scope, minted.TokenPrefix,
		minted.SecretHash, label, createdByUserID,
	).Scan(&minted.ID); err != nil {
		return nil, fmt.Errorf("create project key: %w", err)
	}
	return minted, nil
}

func (q *Queries) CreateProjectKeyTx(
	ctx context.Context,
	tx pgx.Tx,
	projectID, scope, label string,
	createdByUserID *string,
	endpoint string,
) (*MintedProjectKey, error) {
	minted, err := NewProjectKey(scope, endpoint)
	if err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx,
		`INSERT INTO project_api_keys
		   (key_id, project_id, scope, token_prefix, secret_hash, label, created_by_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		minted.KeyID, projectID, minted.Scope, minted.TokenPrefix,
		minted.SecretHash, label, createdByUserID,
	).Scan(&minted.ID); err != nil {
		return nil, fmt.Errorf("create project key tx: %w", err)
	}
	return minted, nil
}

func (q *Queries) LookupProjectKey(ctx context.Context, raw string) (*ProjectKeyLookup, error) {
	parsed, err := ParseProjectKey(raw)
	if err != nil {
		return nil, ErrProjectKeyInvalid
	}

	var (
		out        ProjectKeyLookup
		storedHash string
		revokedAt  *time.Time
	)
	err = q.pool.QueryRow(ctx,
		`SELECT k.project_id, p.org_id, k.scope, k.secret_hash, k.revoked_at,
		        p.allowed_origins, p.allow_payload_environment
		 FROM project_api_keys k
		 JOIN projects p ON p.id = k.project_id
		 WHERE k.key_id = $1`,
		parsed.KeyID,
	).Scan(&out.ProjectID, &out.OrgID, &out.Scope, &storedHash, &revokedAt,
		&out.AllowedOrigins, &out.AllowPayloadEnvironment)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrProjectKeyInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("lookup project key: %w", err)
	}

	secretOK := subtle.ConstantTimeCompare(
		[]byte(HashSecret(parsed.Secret)),
		[]byte(storedHash),
	) == 1
	if !secretOK || out.Scope != parsed.Scope || revokedAt != nil {
		return nil, ErrProjectKeyInvalid
	}

	out.KeyID = parsed.KeyID
	return &out, nil
}
