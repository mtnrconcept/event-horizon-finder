package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

const testAuthToken = "test-token-that-is-at-least-32-characters-long"

type staticResolver struct {
	addresses []netip.Addr
	err       error
}

func (resolver staticResolver) LookupNetIP(
	_ context.Context,
	_, _ string,
) ([]netip.Addr, error) {
	return resolver.addresses, resolver.err
}

func TestIsPublicAddress(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		address string
		want    bool
	}{
		{address: "8.8.8.8", want: true},
		{address: "1.1.1.1", want: true},
		{address: "10.0.0.1", want: false},
		{address: "100.64.0.1", want: false},
		{address: "127.0.0.1", want: false},
		{address: "169.254.169.254", want: false},
		{address: "192.0.2.1", want: false},
		{address: "198.18.0.1", want: false},
		{address: "224.0.0.1", want: false},
		{address: "2606:4700:4700::1111", want: true},
		{address: "::1", want: false},
		{address: "fc00::1", want: false},
		{address: "fe80::1", want: false},
		{address: "fec0::1", want: false},
		{address: "2001:db8::1", want: false},
		{address: "4000::1", want: false},
		{address: "::ffff:127.0.0.1", want: false},
		{address: "::ffff:8.8.8.8", want: true},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.address, func(t *testing.T) {
			t.Parallel()
			got := isPublicAddress(netip.MustParseAddr(testCase.address))
			if got != testCase.want {
				t.Fatalf("isPublicAddress(%q) = %v; want %v", testCase.address, got, testCase.want)
			}
		})
	}
}

func TestParseTarget(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name     string
		target   string
		wantHost string
		wantPort string
		wantCode string
	}{
		{
			name:     "https default port",
			target:   "https://events.example.org/path?q=geneva",
			wantHost: "events.example.org",
			wantPort: "443",
		},
		{
			name:     "http explicit port",
			target:   "http://events.example.org:80/robots.txt",
			wantHost: "events.example.org",
			wantPort: "80",
		},
		{
			name:     "public IP literal",
			target:   "https://8.8.8.8/",
			wantHost: "8.8.8.8",
			wantPort: "443",
		},
		{name: "credentials", target: "https://user:pass@example.org/", wantCode: "invalid_target"},
		{name: "wrong HTTPS port", target: "https://example.org:8443/", wantCode: "port_not_allowed"},
		{name: "wrong scheme port", target: "http://example.org:443/", wantCode: "port_not_allowed"},
		{name: "file scheme", target: "file:///etc/passwd", wantCode: "invalid_target"},
		{name: "loopback literal", target: "http://127.0.0.1/", wantCode: "target_blocked"},
		{name: "metadata address", target: "http://169.254.169.254/", wantCode: "target_blocked"},
		{name: "IPv6 loopback", target: "http://[::1]/", wantCode: "target_blocked"},
		{name: "local name", target: "http://service.internal/", wantCode: "target_blocked"},
		{name: "unicode hostname must be punycode", target: "https://événements.example/", wantCode: "target_blocked"},
		{name: "leading whitespace", target: " https://example.org/", wantCode: "invalid_target"},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			target, proxyErr := parseTarget(testCase.target)
			if testCase.wantCode != "" {
				if proxyErr == nil || proxyErr.Code != testCase.wantCode {
					t.Fatalf("parseTarget(%q) error = %#v; want %q", testCase.target, proxyErr, testCase.wantCode)
				}
				return
			}
			if proxyErr != nil {
				t.Fatalf("parseTarget(%q) unexpected error: %#v", testCase.target, proxyErr)
			}
			if target.Hostname != testCase.wantHost || target.Port != testCase.wantPort {
				t.Fatalf(
					"parseTarget(%q) = host %q port %q; want host %q port %q",
					testCase.target,
					target.Hostname,
					target.Port,
					testCase.wantHost,
					testCase.wantPort,
				)
			}
		})
	}
}

func TestResolvePublicAddressesRejectsMixedAnswers(t *testing.T) {
	t.Parallel()

	resolver := staticResolver{addresses: []netip.Addr{
		netip.MustParseAddr("8.8.8.8"),
		netip.MustParseAddr("10.0.0.5"),
	}}
	addresses, proxyErr := resolvePublicAddresses(context.Background(), time.Second, resolver, "example.org")
	if addresses != nil {
		t.Fatalf("addresses = %v; want nil", addresses)
	}
	if proxyErr == nil || proxyErr.Code != "target_blocked" {
		t.Fatalf("error = %#v; want target_blocked", proxyErr)
	}
}

func TestResolvePublicAddressesDeduplicatesAnswers(t *testing.T) {
	t.Parallel()

	resolver := staticResolver{addresses: []netip.Addr{
		netip.MustParseAddr("8.8.8.8"),
		netip.MustParseAddr("8.8.8.8"),
		netip.MustParseAddr("2606:4700:4700::1111"),
	}}
	addresses, proxyErr := resolvePublicAddresses(context.Background(), time.Second, resolver, "example.org")
	if proxyErr != nil {
		t.Fatalf("unexpected error: %#v", proxyErr)
	}
	if len(addresses) != 2 {
		t.Fatalf("len(addresses) = %d; want 2", len(addresses))
	}
}

func TestResolvePublicAddressesReportsDNSFailure(t *testing.T) {
	t.Parallel()

	resolver := staticResolver{err: errors.New("lookup failed")}
	_, proxyErr := resolvePublicAddresses(context.Background(), time.Second, resolver, "example.org")
	if proxyErr == nil || proxyErr.Code != "dns_failed" {
		t.Fatalf("error = %#v; want dns_failed", proxyErr)
	}
}

func TestFetchHandlerReturnsOpaqueBodyAndMetadata(t *testing.T) {
	t.Parallel()

	app := testServer(func(_ context.Context, target parsedTarget) (*fetchResult, *proxyError) {
		if target.Hostname != "events.example.org" {
			t.Fatalf("hostname = %q; want events.example.org", target.Hostname)
		}
		return &fetchResult{
			Status:       http.StatusFound,
			Location:     "/event/42",
			ContentType:  "text/html; charset=UTF-8",
			CacheControl: "public, max-age=300",
			ETag:         `W/"event-42"`,
			LastModified: "Sun, 19 Jul 2026 01:02:03 GMT",
			RetryAfter:   "120",
			Body:         []byte("<html>event</html>"),
		}, nil
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/fetch",
		strings.NewReader(`{"url":"https://events.example.org/calendar"}`),
	)
	request.Header.Set("Authorization", "Bearer "+testAuthToken)
	request.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(recorder, request)

	response := recorder.Result()
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d; want 200", response.StatusCode)
	}
	if got := response.Header.Get("X-Safe-Fetch-Status"); got != "302" {
		t.Fatalf("X-Safe-Fetch-Status = %q; want 302", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Location"); got != "/event/42" {
		t.Fatalf("X-Safe-Fetch-Location = %q; want /event/42", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Content-Type"); got != "text/html; charset=UTF-8" {
		t.Fatalf("X-Safe-Fetch-Content-Type = %q; want normalized HTML content type", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("X-Safe-Fetch-Cache-Control = %q; want upstream cache policy", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Etag"); got != `W/"event-42"` {
		t.Fatalf("X-Safe-Fetch-Etag = %q; want upstream ETag", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Last-Modified"); got != "Sun, 19 Jul 2026 01:02:03 GMT" {
		t.Fatalf("X-Safe-Fetch-Last-Modified = %q; want canonical date", got)
	}
	if got := response.Header.Get("X-Safe-Fetch-Retry-After"); got != "120" {
		t.Fatalf("X-Safe-Fetch-Retry-After = %q; want bounded delay", got)
	}
	if got := response.Header.Get("Location"); got != "" {
		t.Fatalf("Location = %q; redirects must only use metadata headers", got)
	}
	if got := response.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type = %q; want application/octet-stream", got)
	}
	if recorder.Body.String() != "<html>event</html>" {
		t.Fatalf("body = %q; want upstream body", recorder.Body.String())
	}
}

func TestCheckHealth(t *testing.T) {
	t.Parallel()

	healthServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/healthz" {
			t.Fatalf("health request = %s %s; want GET /healthz", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	}))
	defer healthServer.Close()

	client := &http.Client{Timeout: time.Second}
	if err := checkHealth(client, healthServer.URL+"/healthz"); err != nil {
		t.Fatalf("checkHealth returned %v", err)
	}
}

func TestCheckHealthRejectsUnexpectedResponse(t *testing.T) {
	t.Parallel()

	healthServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
	}))
	defer healthServer.Close()

	client := &http.Client{Timeout: time.Second}
	if err := checkHealth(client, healthServer.URL); err == nil {
		t.Fatal("checkHealth returned nil; want an error")
	}
}

func TestSafeMetadataRejectsMalformedValues(t *testing.T) {
	t.Parallel()

	if got := safeETag("not-quoted"); got != "" {
		t.Fatalf("safeETag returned %q; want empty", got)
	}
	if got := safeHTTPDate("not-a-date"); got != "" {
		t.Fatalf("safeHTTPDate returned %q; want empty", got)
	}
	if got := safeRetryAfter("999999999"); got != "" {
		t.Fatalf("safeRetryAfter returned %q; want empty", got)
	}
	if got := safeHeaderValue("value\nInjected: true", 128); got != "" {
		t.Fatalf("safeHeaderValue returned %q; want empty", got)
	}
}

func TestFetchHandlerRejectsMissingOrDuplicateAuthorization(t *testing.T) {
	t.Parallel()

	app := testServer(func(_ context.Context, _ parsedTarget) (*fetchResult, *proxyError) {
		t.Fatal("fetch must not be called")
		return nil, nil
	})

	testCases := []struct {
		name    string
		headers []string
	}{
		{name: "missing"},
		{name: "wrong token", headers: []string{"Bearer wrong"}},
		{name: "duplicate", headers: []string{"Bearer " + testAuthToken, "Bearer " + testAuthToken}},
	}

	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, "/v1/fetch", strings.NewReader(`{"url":"https://example.org/"}`))
			request.Header.Set("Content-Type", "application/json")
			for _, value := range testCase.headers {
				request.Header.Add("Authorization", value)
			}
			app.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d; want 401", recorder.Code)
			}
		})
	}
}

func testServer(fetch fetchFunc) *server {
	return &server{
		authDigest:      sha256Digest(testAuthToken),
		maxRequestBytes: defaultMaxRequestBytes,
		totalTimeout:    time.Second,
		semaphore:       make(chan struct{}, 2),
		fetch:           fetch,
	}
}

func sha256Digest(value string) [32]byte {
	return sha256.Sum256([]byte(value))
}
