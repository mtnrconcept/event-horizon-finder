package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultListenAddress        = ":8080"
	defaultMaxRequestBytes      = int64(16 * 1024)
	defaultMaxResponseBytes     = int64(5 * 1024 * 1024)
	absoluteMaxResponseBytes    = int64(16 * 1024 * 1024)
	defaultMaxConcurrency       = 32
	defaultTotalTimeout         = 20 * time.Second
	defaultDNSTimeout           = 3 * time.Second
	defaultConnectTimeout       = 5 * time.Second
	defaultResponseHeaderTimeout = 8 * time.Second
	maxTargetURLBytes           = 8 * 1024
)

type config struct {
	ListenAddress         string
	AuthToken             string
	MaxRequestBytes       int64
	MaxResponseBytes      int64
	MaxConcurrency        int
	TotalTimeout          time.Duration
	DNSTimeout            time.Duration
	ConnectTimeout        time.Duration
	ResponseHeaderTimeout time.Duration
}

type dnsResolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type fetchRequest struct {
	URL string `json:"url"`
}

type fetchResult struct {
	Status       int
	Location     string
	ContentType  string
	CacheControl string
	ETag         string
	LastModified string
	RetryAfter   string
	Body         []byte
}

type proxyError struct {
	Status int
	Code   string
}

type parsedTarget struct {
	URL      *url.URL
	Hostname string
	Port     string
}

type fetchFunc func(context.Context, parsedTarget) (*fetchResult, *proxyError)

type server struct {
	authDigest      [sha256.Size]byte
	maxRequestBytes int64
	totalTimeout    time.Duration
	semaphore       chan struct{}
	fetch           fetchFunc
}

var blockedAddressPrefixes = mustPrefixes(
	// IPv4 special-use, loopback, private, link-local, documentation, multicast,
	// benchmarking and reserved ranges.
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.31.196.0/24",
	"192.52.193.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"192.175.48.0/24",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	// IPv6 unspecified, loopback, translation, discard, special-use,
	// documentation, 6to4, unique-local, link-local and multicast ranges.
	"::/128",
	"::1/128",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"100::/64",
	"2001::/23",
	"2001:db8::/32",
	"2002::/16",
	"3fff::/20",
	"5f00::/16",
	"fc00::/7",
	"fe80::/10",
	"fec0::/10",
	"ff00::/8",
)

var allocatedGlobalIPv6Prefix = netip.MustParsePrefix("2000::/3")

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	app := newServer(cfg, net.DefaultResolver)
	httpServer := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.TotalTimeout + 5*time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("safe-fetch-proxy listening on %s", cfg.ListenAddress)
		serverErrors <- httpServer.ListenAndServe()
	}()

	signalContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	select {
	case <-signalContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}
}

func newServer(cfg config, resolver dnsResolver) *server {
	productionFetcher := func(ctx context.Context, target parsedTarget) (*fetchResult, *proxyError) {
		return fetchTarget(ctx, cfg, resolver, target)
	}

	return &server{
		authDigest:      sha256.Sum256([]byte(cfg.AuthToken)),
		maxRequestBytes: cfg.MaxRequestBytes,
		totalTimeout:    cfg.TotalTimeout,
		semaphore:       make(chan struct{}, cfg.MaxConcurrency),
		fetch:           productionFetcher,
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())

	if r.URL.Path == "/healthz" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeProxyError(w, &proxyError{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed"})
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
		return
	}

	if r.URL.Path != "/v1/fetch" {
		writeProxyError(w, &proxyError{Status: http.StatusNotFound, Code: "not_found"})
		return
	}

	if !s.authorized(r.Header.Values("Authorization")) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="safe-fetch-proxy"`)
		writeProxyError(w, &proxyError{Status: http.StatusUnauthorized, Code: "unauthorized"})
		return
	}

	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeProxyError(w, &proxyError{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed"})
		return
	}

	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeProxyError(w, &proxyError{Status: http.StatusUnsupportedMediaType, Code: "content_type_must_be_json"})
		return
	}

	select {
	case s.semaphore <- struct{}{}:
		defer func() { <-s.semaphore }()
	default:
		w.Header().Set("Retry-After", "1")
		writeProxyError(w, &proxyError{Status: http.StatusTooManyRequests, Code: "busy"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, s.maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	var request fetchRequest
	if err := decoder.Decode(&request); err != nil {
		writeProxyError(w, &proxyError{Status: http.StatusBadRequest, Code: "invalid_json"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeProxyError(w, &proxyError{Status: http.StatusBadRequest, Code: "invalid_json"})
		return
	}

	target, targetError := parseTarget(request.URL)
	if targetError != nil {
		writeProxyError(w, targetError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.totalTimeout)
	defer cancel()
	result, fetchError := s.fetch(ctx, target)
	if fetchError != nil {
		writeProxyError(w, fetchError)
		return
	}

	// A contacted upstream always maps to HTTP 200 at the proxy layer. Redirect
	// metadata is deliberately carried in X-Safe-Fetch-* headers so a fetch
	// client cannot accidentally follow an upstream Location outside this proxy.
	w.Header().Set("X-Safe-Fetch-Status", strconv.Itoa(result.Status))
	if location := safeHeaderValue(result.Location, maxTargetURLBytes); location != "" {
		w.Header().Set("X-Safe-Fetch-Location", location)
	}
	if contentType := safeContentType(result.ContentType); contentType != "" {
		w.Header().Set("X-Safe-Fetch-Content-Type", contentType)
	}
	if cacheControl := safeHeaderValue(result.CacheControl, 1024); cacheControl != "" {
		w.Header().Set("X-Safe-Fetch-Cache-Control", cacheControl)
	}
	if etag := safeETag(result.ETag); etag != "" {
		w.Header().Set("X-Safe-Fetch-Etag", etag)
	}
	if lastModified := safeHTTPDate(result.LastModified); lastModified != "" {
		w.Header().Set("X-Safe-Fetch-Last-Modified", lastModified)
	}
	if retryAfter := safeRetryAfter(result.RetryAfter); retryAfter != "" {
		w.Header().Set("X-Safe-Fetch-Retry-After", retryAfter)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(result.Body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Body)
}

func (s *server) authorized(values []string) bool {
	if len(values) != 1 {
		return false
	}

	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}

	providedDigest := sha256.Sum256([]byte(parts[1]))
	return subtle.ConstantTimeCompare(providedDigest[:], s.authDigest[:]) == 1
}

func fetchTarget(
	ctx context.Context,
	cfg config,
	resolver dnsResolver,
	target parsedTarget,
) (*fetchResult, *proxyError) {
	addresses, resolveError := resolvePublicAddresses(ctx, cfg.DNSTimeout, resolver, target.Hostname)
	if resolveError != nil {
		return nil, resolveError
	}

	dialer := &net.Dialer{
		Timeout:   cfg.ConnectTimeout,
		KeepAlive: -1,
	}
	dialContext := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var lastError error
		for _, address := range addresses {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.String(), target.Port))
			if err == nil {
				return connection, nil
			}
			lastError = err
		}
		if lastError == nil {
			lastError = errors.New("no resolved address")
		}
		return nil, lastError
	}

	transport := &http.Transport{
		Proxy:                   nil,
		DialContext:             dialContext,
		ForceAttemptHTTP2:        true,
		DisableKeepAlives:        true,
		MaxConnsPerHost:          1,
		TLSHandshakeTimeout:      cfg.ConnectTimeout,
		ResponseHeaderTimeout:   cfg.ResponseHeaderTimeout,
		ExpectContinueTimeout:   time.Second,
		MaxResponseHeaderBytes:  64 * 1024,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: target.Hostname,
		},
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		Timeout:   cfg.TotalTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.URL.String(), nil)
	if err != nil {
		return nil, &proxyError{Status: http.StatusBadRequest, Code: "invalid_target"}
	}
	request.Host = target.URL.Host
	request.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.1")
	request.Header.Set("Accept-Language", "en,fr;q=0.8,*;q=0.2")
	request.Header.Set("User-Agent", "GlobalParty-Event-Discovery/1.0 (+https://github.com/mtnrconcept/event-horizon-finder)")

	response, err := client.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, &proxyError{Status: http.StatusGatewayTimeout, Code: "upstream_timeout"}
		}
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "upstream_unreachable"}
	}
	defer response.Body.Close()

	if response.ContentLength > cfg.MaxResponseBytes {
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "upstream_body_too_large"}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, cfg.MaxResponseBytes+1))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
			return nil, &proxyError{Status: http.StatusGatewayTimeout, Code: "upstream_timeout"}
		}
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "upstream_read_failed"}
	}
	if int64(len(body)) > cfg.MaxResponseBytes {
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "upstream_body_too_large"}
	}

	return &fetchResult{
		Status:       response.StatusCode,
		Location:     response.Header.Get("Location"),
		ContentType:  response.Header.Get("Content-Type"),
		CacheControl: response.Header.Get("Cache-Control"),
		ETag:         response.Header.Get("ETag"),
		LastModified: response.Header.Get("Last-Modified"),
		RetryAfter:   response.Header.Get("Retry-After"),
		Body:         body,
	}, nil
}

func parseTarget(rawTarget string) (parsedTarget, *proxyError) {
	if rawTarget == "" || len(rawTarget) > maxTargetURLBytes || strings.TrimSpace(rawTarget) != rawTarget {
		return parsedTarget{}, &proxyError{Status: http.StatusBadRequest, Code: "invalid_target"}
	}

	parsed, err := url.ParseRequestURI(rawTarget)
	if err != nil || parsed.Opaque != "" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return parsedTarget{}, &proxyError{Status: http.StatusBadRequest, Code: "invalid_target"}
	}

	scheme := strings.ToLower(parsed.Scheme)
	expectedPort := ""
	switch scheme {
	case "http":
		expectedPort = "80"
	case "https":
		expectedPort = "443"
	default:
		return parsedTarget{}, &proxyError{Status: http.StatusBadRequest, Code: "scheme_not_allowed"}
	}

	hostname := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if hostname == "" || strings.Contains(hostname, "%") {
		return parsedTarget{}, &proxyError{Status: http.StatusBadRequest, Code: "invalid_target"}
	}

	if address, err := netip.ParseAddr(hostname); err == nil {
		address = address.Unmap()
		hostname = address.String()
		if !isPublicAddress(address) {
			return parsedTarget{}, &proxyError{Status: http.StatusForbidden, Code: "target_blocked"}
		}
	} else if !validDNSName(hostname) || reservedDNSName(hostname) {
		return parsedTarget{}, &proxyError{Status: http.StatusForbidden, Code: "target_blocked"}
	}

	explicitPort := parsed.Port()
	if explicitPort != "" && explicitPort != expectedPort {
		return parsedTarget{}, &proxyError{Status: http.StatusForbidden, Code: "port_not_allowed"}
	}

	parsed.Scheme = scheme
	if strings.Contains(hostname, ":") {
		parsed.Host = "[" + hostname + "]"
	} else {
		parsed.Host = hostname
	}
	if explicitPort != "" {
		parsed.Host = net.JoinHostPort(hostname, explicitPort)
	}

	return parsedTarget{URL: parsed, Hostname: hostname, Port: expectedPort}, nil
}

func resolvePublicAddresses(
	ctx context.Context,
	timeout time.Duration,
	resolver dnsResolver,
	hostname string,
) ([]netip.Addr, *proxyError) {
	if address, err := netip.ParseAddr(hostname); err == nil {
		address = address.Unmap()
		if !isPublicAddress(address) {
			return nil, &proxyError{Status: http.StatusForbidden, Code: "target_blocked"}
		}
		return []netip.Addr{address}, nil
	}

	resolveContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	addresses, err := resolver.LookupNetIP(resolveContext, "ip", hostname)
	if err != nil || len(addresses) == 0 {
		if errors.Is(resolveContext.Err(), context.DeadlineExceeded) {
			return nil, &proxyError{Status: http.StatusGatewayTimeout, Code: "dns_timeout"}
		}
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "dns_failed"}
	}

	unique := make(map[netip.Addr]struct{}, len(addresses))
	publicAddresses := make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		if address.Zone() != "" {
			return nil, &proxyError{Status: http.StatusForbidden, Code: "target_blocked"}
		}
		address = address.Unmap()
		if !isPublicAddress(address) {
			// Reject mixed public/private DNS answers instead of silently selecting
			// the public subset. This closes a common DNS-rebinding ambiguity.
			return nil, &proxyError{Status: http.StatusForbidden, Code: "target_blocked"}
		}
		if _, exists := unique[address]; exists {
			continue
		}
		unique[address] = struct{}{}
		publicAddresses = append(publicAddresses, address)
	}

	if len(publicAddresses) == 0 {
		return nil, &proxyError{Status: http.StatusBadGateway, Code: "dns_failed"}
	}
	return publicAddresses, nil
}

func isPublicAddress(address netip.Addr) bool {
	if !address.IsValid() || address.Zone() != "" {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() {
		return false
	}
	if address.Is6() && !allocatedGlobalIPv6Prefix.Contains(address) {
		return false
	}
	for _, prefix := range blockedAddressPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func validDNSName(hostname string) bool {
	if len(hostname) > 253 || strings.Contains(hostname, "..") {
		return false
	}
	for _, label := range strings.Split(hostname, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character >= 'a' && character <= 'z') ||
				(character >= '0' && character <= '9') || character == '-' {
				continue
			}
			return false
		}
	}
	return true
}

func reservedDNSName(hostname string) bool {
	reservedSuffixes := []string{
		"localhost",
		"local",
		"localdomain",
		"internal",
		"home",
		"home.arpa",
		"invalid",
		"onion",
		"example",
		"test",
	}
	for _, suffix := range reservedSuffixes {
		if hostname == suffix || strings.HasSuffix(hostname, "."+suffix) {
			return true
		}
	}
	return false
}

func safeContentType(value string) string {
	value = safeHeaderValue(value, 512)
	if value == "" {
		return ""
	}
	mediaType, parameters, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	return mime.FormatMediaType(mediaType, parameters)
}

func safeETag(value string) string {
	value = safeHeaderValue(strings.TrimSpace(value), 512)
	if value == "" {
		return ""
	}
	quoted := value
	if strings.HasPrefix(quoted, "W/") {
		quoted = strings.TrimPrefix(quoted, "W/")
	}
	if len(quoted) < 2 || quoted[0] != '"' || quoted[len(quoted)-1] != '"' {
		return ""
	}
	for _, character := range quoted[1 : len(quoted)-1] {
		if character == '"' || character == 0x7f || character < 0x21 {
			return ""
		}
	}
	return value
}

func safeHTTPDate(value string) string {
	value = safeHeaderValue(strings.TrimSpace(value), 128)
	if value == "" {
		return ""
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(http.TimeFormat)
}

func safeRetryAfter(value string) string {
	value = safeHeaderValue(strings.TrimSpace(value), 128)
	if value == "" {
		return ""
	}
	if seconds, err := strconv.ParseUint(value, 10, 32); err == nil {
		// A week is already well beyond a single crawl lease. Refuse extreme
		// attacker-controlled values rather than poisoning scheduling metadata.
		if seconds <= 7*24*60*60 {
			return strconv.FormatUint(seconds, 10)
		}
		return ""
	}
	return safeHTTPDate(value)
}

func safeHeaderValue(value string, maxBytes int) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxBytes {
		return ""
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return ""
		}
	}
	return value
}

func setSecurityHeaders(headers http.Header) {
	headers.Set("Cache-Control", "no-store")
	headers.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox")
	headers.Set("Referrer-Policy", "no-referrer")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Frame-Options", "DENY")
}

func writeProxyError(w http.ResponseWriter, proxyErr *proxyError) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	w.Header().Set("X-Safe-Fetch-Error", proxyErr.Code)
	w.WriteHeader(proxyErr.Status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": proxyErr.Code})
}

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefixes = append(prefixes, netip.MustParsePrefix(value))
	}
	return prefixes
}

func loadConfig() (config, error) {
	authToken := strings.TrimSpace(os.Getenv("SAFE_FETCH_AUTH_TOKEN"))
	if len(authToken) < 32 {
		return config{}, errors.New("SAFE_FETCH_AUTH_TOKEN must contain at least 32 characters")
	}

	maxResponseBytes, err := boundedInt64Env(
		"SAFE_FETCH_MAX_RESPONSE_BYTES",
		defaultMaxResponseBytes,
		64*1024,
		absoluteMaxResponseBytes,
	)
	if err != nil {
		return config{}, err
	}
	maxConcurrency, err := boundedIntEnv("SAFE_FETCH_MAX_CONCURRENCY", defaultMaxConcurrency, 1, 128)
	if err != nil {
		return config{}, err
	}
	totalTimeout, err := boundedDurationEnv("SAFE_FETCH_TOTAL_TIMEOUT", defaultTotalTimeout, 2*time.Second, 60*time.Second)
	if err != nil {
		return config{}, err
	}
	dnsTimeout, err := boundedDurationEnv("SAFE_FETCH_DNS_TIMEOUT", defaultDNSTimeout, time.Second, 10*time.Second)
	if err != nil {
		return config{}, err
	}
	connectTimeout, err := boundedDurationEnv("SAFE_FETCH_CONNECT_TIMEOUT", defaultConnectTimeout, time.Second, 15*time.Second)
	if err != nil {
		return config{}, err
	}
	responseHeaderTimeout, err := boundedDurationEnv(
		"SAFE_FETCH_RESPONSE_HEADER_TIMEOUT",
		defaultResponseHeaderTimeout,
		time.Second,
		20*time.Second,
	)
	if err != nil {
		return config{}, err
	}

	listenAddress := strings.TrimSpace(os.Getenv("SAFE_FETCH_LISTEN_ADDRESS"))
	if listenAddress == "" {
		listenAddress = defaultListenAddress
	}

	return config{
		ListenAddress:         listenAddress,
		AuthToken:             authToken,
		MaxRequestBytes:       defaultMaxRequestBytes,
		MaxResponseBytes:      maxResponseBytes,
		MaxConcurrency:        maxConcurrency,
		TotalTimeout:          totalTimeout,
		DNSTimeout:            dnsTimeout,
		ConnectTimeout:        connectTimeout,
		ResponseHeaderTimeout: responseHeaderTimeout,
	}, nil
}

func boundedInt64Env(name string, fallback, minimum, maximum int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return value, nil
}

func boundedIntEnv(name string, fallback, minimum, maximum int) (int, error) {
	value, err := boundedInt64Env(name, int64(fallback), int64(minimum), int64(maximum))
	return int(value), err
}

func boundedDurationEnv(
	name string,
	fallback time.Duration,
	minimum time.Duration,
	maximum time.Duration,
) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be between %s and %s", name, minimum, maximum)
	}
	return value, nil
}
