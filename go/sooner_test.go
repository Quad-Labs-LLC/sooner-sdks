package sooner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testKey = "sn_abcdefghijklmnop"

func TestEmailWireContract(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Error("missing credential")
		}
		if r.Method == "POST" && r.URL.Path == "/emails" {
			if r.Header.Get("Idempotency-Key") != "order-123" {
				t.Error("idempotency header missing")
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["reply_to"] == nil || body["scheduled_at"] != "in 1 hour" {
				t.Error("incorrect wire fields")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/emails":
			if r.Method == "GET" {
				if r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("after") != "email1" {
					t.Error("pagination query missing")
				}
				w.Write([]byte(`{"object":"list","data":[],"has_more":false}`))
			} else {
				w.Write([]byte(`{"id":"email1"}`))
			}
		case "/emails/batch":
			if r.Method != http.MethodPost {
				t.Error("batch requires POST")
			}
			var emails []SendEmail
			if err := json.NewDecoder(r.Body).Decode(&emails); err != nil || len(emails) != 1 {
				t.Error("batch body must be an email array", err)
			}
			w.Write([]byte(`{"data":[{"id":"email1"}]}`))
		case "/emails/email1":
			if r.Method == http.MethodPatch {
				var body map[string]string
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["scheduled_at"] != "in 2 hours" {
					t.Error("reschedule wire field missing", err)
				}
			} else if r.Method != http.MethodGet {
				t.Error("unexpected email method")
			}
			w.Write([]byte(`{"object":"email","id":"email1","html":null,"status":"scheduled"}`))
		case "/emails/email1/cancel":
			if r.Method != http.MethodPost {
				t.Error("cancel requires POST")
			}
			w.Write([]byte(`{"object":"email","id":"email1"}`))
		default:
			t.Error("unexpected endpoint")
		}
	}))
	defer server.Close()
	client, err := New(testKey, Options{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	email := SendEmail{From: "a@example.com", To: []string{"b@example.com"}, Text: "Hi", ReplyTo: []string{"reply@example.com"}, ScheduledAt: "in 1 hour"}
	if result, err := client.Emails.Send(context.Background(), email, SendOptions{IdempotencyKey: "order-123"}); err != nil || result.ID != "email1" {
		t.Fatal(result, err)
	}
	email.ScheduledAt = ""
	if _, err := client.Emails.SendBatch(context.Background(), []SendEmail{email}, SendOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Emails.List(context.Background(), ListOptions{Limit: 2, After: "email1"}); err != nil {
		t.Fatal(err)
	}
	if result, err := client.Emails.Get(context.Background(), "email1"); err != nil || result.HTML != nil {
		t.Fatal(result, err)
	}
	if _, err := client.Emails.Reschedule(context.Background(), "email1", "in 2 hours"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Emails.Cancel(context.Background(), "email1"); err != nil {
		t.Fatal(err)
	}
	if requests != 6 {
		t.Fatalf("got %d requests", requests)
	}
}

func TestErrorsAndRedirectCredentialFence(t *testing.T) {
	for _, code := range []int{302, 429, 500} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			forwarded := false
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
			defer target.Close()
			calls := 0
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Location", target.URL)
				w.Header().Set("Retry-After", "12")
				w.WriteHeader(code)
				w.Write([]byte(`{"name":"rate_limit_exceeded","message":"Slow down"}`))
			}))
			defer source.Close()
			client, _ := New(testKey, Options{BaseURL: source.URL})
			_, err := client.Emails.Get(context.Background(), "email1")
			var apiError *APIError
			if !errors.As(err, &apiError) || apiError.StatusCode != code || apiError.RetryAfter != "12" {
				t.Fatal(err)
			}
			if calls != 1 || forwarded {
				t.Fatal("request was retried or redirected")
			}
		})
	}
}

func TestUnsafeInputs(t *testing.T) {
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=1"} {
		if _, err := New(testKey, Options{BaseURL: origin}); err == nil {
			t.Fatalf("accepted %s", origin)
		}
	}
	client, _ := New(testKey, Options{})
	for _, id := range []string{"..", "../domains", "email/id", "%2e%2e"} {
		if _, err := client.Emails.Get(context.Background(), id); err == nil {
			t.Fatalf("accepted %s", id)
		}
	}
	if _, err := client.Emails.SendBatch(context.Background(), []SendEmail{{ScheduledAt: "tomorrow"}}, SendOptions{}); err == nil {
		t.Fatal("accepted scheduled batch")
	}
}

func TestDeadlineAndMalformedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "slow") {
			<-r.Context().Done()
			return
		}
		w.Write([]byte("invalid json"))
	}))
	defer server.Close()
	client, _ := New(testKey, Options{BaseURL: server.URL, Timeout: 20 * time.Millisecond})
	if _, err := client.Emails.Get(context.Background(), "broken"); err == nil {
		t.Fatal("accepted malformed response")
	}
	_, err := client.Emails.Get(context.Background(), "slow")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline lost: %v", err)
	}
}

type failingTransport func(*http.Request) (*http.Response, error)

func (transport failingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestTransportErrorRedactsCredentials(t *testing.T) {
	httpClient := &http.Client{Transport: failingTransport(func(request *http.Request) (*http.Response, error) {
		return nil, errors.New("transport diagnostic: " + request.Header.Get("Authorization"))
	})}
	client, err := New(testKey, Options{HTTPClient: httpClient})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Emails.Get(context.Background(), "email1")
	if err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("credential leaked in error: %v", err)
	}
	var transportError *TransportError
	if !errors.As(err, &transportError) {
		t.Fatal("missing typed transport failure")
	}
}

func TestAPIErrorRedactsEchoedCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", testKey)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"name": testKey, "message": "echo " + testKey})
	}))
	defer server.Close()
	client, _ := New(testKey, Options{BaseURL: server.URL})
	_, err := client.Emails.Get(context.Background(), "email1")
	var apiError *APIError
	if !errors.As(err, &apiError) || strings.Contains(apiError.Error()+apiError.RetryAfter, testKey) {
		t.Fatalf("unsafe API error: %v", err)
	}
}
