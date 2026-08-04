package grouping

import (
	"crypto/sha256"
	"fmt"
	"strings"
)

// FamilyTitleStaleDeploy is the stable group title for the stale-deploy family;
// the per-event "Type: Message" title would churn with each deploy's hash.
const FamilyTitleStaleDeploy = "Stale deploy: hashed asset failed to load after release"

// staleDeployKey uses the domain-separated, locked key format and never embeds
// raw message text.
var staleDeployKey = func() string {
	hash := sha256.Sum256([]byte("stale-deploy"))
	return fmt.Sprintf("js|v2|r1|%x", hash[:16])
}()

// familyNeedles are the documented browser/bundler wordings. Substring matching
// accommodates SDKs and wrappers that include an error-type prefix.
var familyNeedles = []string{
	"failed to fetch dynamically imported module",
	"error loading dynamically imported module",
	"importing a module script failed",
	"unable to preload css",
}

// FamilyFingerprint maps stale-deploy asset failures to one family fingerprint
// (rung 1). Per-project scope is enforced by the database uniqueness constraint.
func FamilyFingerprint(platform, errorMessage string) (string, bool) {
	if platform != "javascript" {
		return "", false
	}
	message := strings.ToLower(errorMessage)
	for _, needle := range familyNeedles {
		if strings.Contains(message, needle) {
			return staleDeployKey, true
		}
	}
	return "", false
}
