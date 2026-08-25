package notify

import (
	"net"
	"net/url"
	"strconv"
	"strings"
)

// BuildIncidentURL builds a reader-facing incident URL from explicit HTTP(S)
// configuration. Invalid, credentialed, or loopback bases are rejected.
func BuildIncidentURL(dashboardURL, errorGroupID, projectID string) string {
	base, err := url.Parse(strings.TrimSpace(dashboardURL))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil {
		return ""
	}
	if isLoopbackHost(base.Hostname()) {
		return ""
	}
	base.RawQuery = ""
	base.Fragment = ""
	basePath := strings.TrimRight(base.Path, "/")
	escapedBasePath := strings.TrimRight(base.EscapedPath(), "/")
	base.Path = basePath + "/incidents/" + errorGroupID
	base.RawPath = escapedBasePath + "/incidents/" + url.PathEscape(errorGroupID)
	query := url.Values{}
	query.Set("project_id", projectID)
	base.RawQuery = query.Encode()
	return base.String()
}

// BuildSessionURL builds a reader-facing replay URL from explicit HTTP(S)
// configuration. Invalid, credentialed, loopback, or fragment-bearing bases
// are rejected.
func BuildSessionURL(dashboardURL, sessionID string, anchorMs int64) string {
	if strings.TrimSpace(sessionID) == "" {
		return ""
	}
	base, err := url.Parse(strings.TrimSpace(dashboardURL))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.Fragment != "" {
		return ""
	}
	if isLoopbackHost(base.Hostname()) {
		return ""
	}
	base.RawQuery = ""
	basePath := strings.TrimRight(base.Path, "/")
	escapedBasePath := strings.TrimRight(base.EscapedPath(), "/")
	base.Path = basePath + "/sessions/" + sessionID
	base.RawPath = escapedBasePath + "/sessions/" + url.PathEscape(sessionID)
	query := url.Values{}
	query.Set("t", strconv.FormatInt(anchorMs, 10))
	base.RawQuery = query.Encode()
	return base.String()
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "0.0.0.0" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}
