// Package sooner provides a typed client for the Sooner email API.
package sooner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.sooner.dev"
const maxResponseBytes = 4 * 1024 * 1024

// Options configures a client. HTTPClient is copied so its redirect policy is
// never changed. Redirects are always rejected to protect the project API key.
type Options struct {
	BaseURL    string
	Timeout    time.Duration
	HTTPClient *http.Client
}

type Client struct {
	Emails  *EmailsService
	baseURL string
	apiKey  string
	http    *http.Client
	timeout time.Duration
}

type EmailsService struct{ client *Client }

// TransportError safely reports request failures without exposing transport
// diagnostics. Is supports errors.Is for context cancellation and deadlines.
type TransportError struct {
	message string
	cause   error
}

func (e *TransportError) Error() string        { return e.message }
func (e *TransportError) Is(target error) bool { return errors.Is(e.cause, target) }
func (e *TransportError) GoString() string     { return e.Error() }

func (c *Client) String() string {
	return fmt.Sprintf("sooner.Client{BaseURL: %q}", c.baseURL)
}

// GoString keeps the API key out of client values formatted with %#v.
func (c *Client) GoString() string { return c.String() }

// APIError contains a non-success API response. RetryAfter preserves either
// form of the Retry-After HTTP header.
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	RetryAfter string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("sooner: %s (%d): %s", e.Code, e.StatusCode, e.Message)
}

// New creates a client with a 30-second total request deadline by default.
// API keys and origins are fixed per client. No method automatically retries.
func New(apiKey string, options Options) (*Client, error) {
	if !regexp.MustCompile(`^sn_[A-Za-z0-9_-]{16,200}$`).MatchString(apiKey) {
		return nil, errors.New("sooner: a native sn_ project API key is required")
	}
	base := options.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("sooner: base URL must be an HTTPS origin or loopback HTTP origin")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, errors.New("sooner: base URL must be an HTTPS origin or loopback HTTP origin")
	}
	if options.Timeout < 0 {
		return nil, errors.New("sooner: timeout must be positive")
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	h := http.Client{}
	if options.HTTPClient != nil {
		h = *options.HTTPClient
	}
	h.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	c := &Client{baseURL: strings.TrimSuffix(base, "/"), apiKey: apiKey, http: &h, timeout: timeout}
	c.Emails = &EmailsService{client: c}
	return c, nil
}

type Tag struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Content is base64 data. Path is a public attachment URL.
type Attachment struct {
	Filename    string `json:"filename,omitempty"`
	Content     string `json:"content,omitempty"`
	Path        string `json:"path,omitempty"`
	ContentType string `json:"content_type,omitempty"`
	ContentID   string `json:"content_id,omitempty"`
}

type Template struct {
	ID        string         `json:"id"`
	Variables map[string]any `json:"variables,omitempty"`
}

// SendEmail uses the API's canonical snake_case field names on the wire.
// Template variables support string and numeric values.
type SendEmail struct {
	From        string            `json:"from,omitempty"`
	To          []string          `json:"to"`
	Subject     string            `json:"subject,omitempty"`
	HTML        string            `json:"html,omitempty"`
	Text        string            `json:"text,omitempty"`
	CC          []string          `json:"cc,omitempty"`
	BCC         []string          `json:"bcc,omitempty"`
	ReplyTo     []string          `json:"reply_to,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	Tags        []Tag             `json:"tags,omitempty"`
	Attachments []Attachment      `json:"attachments,omitempty"`
	Template    *Template         `json:"template,omitempty"`
	ScheduledAt string            `json:"scheduled_at,omitempty"`
	TopicID     string            `json:"topic_id,omitempty"`
}

type SendOptions struct {
	IdempotencyKey string
}

type EmailID struct {
	ID     string `json:"id"`
	Object string `json:"object,omitempty"`
}

type BatchResult struct {
	Data []EmailID `json:"data"`
}

type Email struct {
	Object      string   `json:"object"`
	ID          string   `json:"id"`
	From        string   `json:"from"`
	To          []string `json:"to"`
	CC          []string `json:"cc"`
	BCC         []string `json:"bcc"`
	ReplyTo     []string `json:"reply_to"`
	Subject     string   `json:"subject"`
	HTML        *string  `json:"html"`
	Text        *string  `json:"text"`
	Tags        []Tag    `json:"tags"`
	CreatedAt   string   `json:"created_at"`
	ScheduledAt *string  `json:"scheduled_at"`
	LastEvent   string   `json:"last_event"`
	Status      string   `json:"status"`
	Error       string   `json:"error,omitempty"`
}

type EmailList struct {
	Object  string  `json:"object"`
	Data    []Email `json:"data"`
	HasMore bool    `json:"has_more"`
}

type ListOptions struct {
	Limit int
	After string
}

func (e *EmailsService) Send(ctx context.Context, email SendEmail, options SendOptions) (*EmailID, error) {
	var result EmailID
	err := e.client.request(ctx, http.MethodPost, "/emails", email, options.IdempotencyKey, &result)
	return &result, err
}

func (e *EmailsService) SendBatch(ctx context.Context, emails []SendEmail, options SendOptions) (*BatchResult, error) {
	if len(emails) == 0 || len(emails) > 100 {
		return nil, errors.New("sooner: batch must contain 1 to 100 emails")
	}
	for _, email := range emails {
		if len(email.Attachments) > 0 || email.ScheduledAt != "" {
			return nil, errors.New("sooner: batch emails cannot include attachments or scheduled_at")
		}
	}
	var result BatchResult
	err := e.client.request(ctx, http.MethodPost, "/emails/batch", emails, options.IdempotencyKey, &result)
	return &result, err
}

func (e *EmailsService) List(ctx context.Context, options ListOptions) (*EmailList, error) {
	params := url.Values{}
	if options.Limit != 0 {
		if options.Limit < 1 || options.Limit > 100 {
			return nil, errors.New("sooner: limit must be between 1 and 100")
		}
		params.Set("limit", strconv.Itoa(options.Limit))
	}
	if options.After != "" {
		if _, err := emailPath(options.After); err != nil {
			return nil, err
		}
		params.Set("after", options.After)
	}
	path := "/emails"
	if len(params) > 0 {
		path += "?" + params.Encode()
	}
	var result EmailList
	err := e.client.request(ctx, http.MethodGet, path, nil, "", &result)
	return &result, err
}

func (e *EmailsService) Get(ctx context.Context, id string) (*Email, error) {
	path, err := emailPath(id)
	if err != nil {
		return nil, err
	}
	var result Email
	err = e.client.request(ctx, http.MethodGet, path, nil, "", &result)
	return &result, err
}

func (e *EmailsService) Reschedule(ctx context.Context, id, scheduledAt string) (*EmailID, error) {
	path, err := emailPath(id)
	if err != nil {
		return nil, err
	}
	var result EmailID
	err = e.client.request(ctx, http.MethodPatch, path, struct {
		ScheduledAt string `json:"scheduled_at"`
	}{scheduledAt}, "", &result)
	return &result, err
}

func (e *EmailsService) Cancel(ctx context.Context, id string) (*EmailID, error) {
	path, err := emailPath(id)
	if err != nil {
		return nil, err
	}
	var result EmailID
	err = e.client.request(ctx, http.MethodPost, path+"/cancel", nil, "", &result)
	return &result, err
}

var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func emailPath(id string) (string, error) {
	if !validID.MatchString(id) {
		return "", errors.New("sooner: invalid email ID")
	}
	return "/emails/" + url.PathEscape(id), nil
}

func (c *Client) request(ctx context.Context, method, path string, body any, key string, result any) error {
	if key != "" && (len(key) > 256 || strings.ContainsAny(key, "\r\n")) {
		return errors.New("sooner: invalid idempotency key")
	}
	var payload io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return &TransportError{message: "sooner: could not encode request", cause: err}
		}
		payload = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, payload)
	if err != nil {
		return &TransportError{message: "sooner: could not create request", cause: err}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "sooner-go/0.1.0")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		// The default transport can replay idempotency-keyed bodies on a stale
		// connection when GetBody is set. Leave the retry decision to the caller.
		req.GetBody = nil
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	response, err := c.http.Do(req)
	if err != nil {
		return &TransportError{message: "sooner: request failed, a write outcome may be unknown; reuse its idempotency key", cause: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return &TransportError{message: "sooner: could not read response, a write outcome may be unknown", cause: err}
	}
	if len(data) > maxResponseBytes {
		return errors.New("sooner: response exceeded 4 MiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Name == "" {
			failure.Name = "http_error"
		}
		if failure.Message == "" {
			failure.Message = http.StatusText(response.StatusCode)
		}
		redact := func(value string) string { return strings.ReplaceAll(value, c.apiKey, "[redacted]") }
		return &APIError{StatusCode: response.StatusCode, Code: redact(failure.Name), Message: redact(failure.Message), RetryAfter: redact(response.Header.Get("Retry-After"))}
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("sooner: expected a JSON object, a write outcome may be unknown")
	}
	if err := json.Unmarshal(data, result); err != nil {
		return &TransportError{message: "sooner: invalid API response, a write outcome may be unknown", cause: err}
	}
	return nil
}
