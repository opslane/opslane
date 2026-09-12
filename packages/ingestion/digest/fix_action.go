package digest

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/notify"
)

func ticketFixActionURL(base, project, group, ticket string, generation int, latest string, secret []byte, now time.Time) (string, error) {
	// Share the public-link configuration rules, including deployment subpaths.
	issue := notify.BuildIncidentURL(base, group, project)
	if issue == "" {
		return "", nil
	}
	target, err := url.Parse(issue)
	if err != nil {
		return "", err
	}
	token, err := auth.SignTicketFixIntent(secret, auth.TicketFixIntent{ProjectID: project, IncidentID: group, TicketID: ticket, Generation: generation, LatestAttemptID: latest, ExpiresAt: now.Add(7 * 24 * time.Hour).Unix()})
	if err != nil {
		return "", fmt.Errorf("sign digest fix action: %w", err)
	}
	target.Path = strings.TrimSuffix(target.Path, "/incidents/"+group) + "/issues/" + group
	target.RawPath = ""
	query := target.Query()
	query.Set("fixIntent", token)
	target.RawQuery = query.Encode()
	return target.String(), nil
}
