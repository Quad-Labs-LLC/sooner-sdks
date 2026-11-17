use sooner_email::{SendEmail, Sooner};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Duration,
};

fn fixture(status: &str, headers: &str, body: &str) -> (String, mpsc::Receiver<String>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", server.local_addr().unwrap());
    let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 2048];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            let request = String::from_utf8_lossy(&bytes);
            if let Some(position) = request.find("\r\n\r\n") {
                let length: usize = request[..position]
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= position + 4 + length {
                    break;
                }
            }
        }
        let _ = sender.send(String::from_utf8(bytes).unwrap());
        let _ = stream.write_all(response.as_bytes());
    });
    (address, receiver)
}
fn client(origin: &str) -> Sooner {
    Sooner::with_options("sn_test_fixture_key", origin, Duration::from_secs(2)).unwrap()
}
#[tokio::test]
async fn send_preserves_wire_fields_and_idempotency() {
    let (origin, request) = fixture("200 OK", "", r#"{"id":"email_1"}"#);
    let email = SendEmail {
        to: Some("recipient@example.test".into()),
        from: Some("from@example.test".into()),
        subject: Some("Hello".into()),
        text: Some("Hi".into()),
        scheduled_at: Some("in 1 hour".into()),
        ..Default::default()
    };
    let result = client(&origin)
        .emails()
        .send(&email, Some("order-1"))
        .await
        .unwrap();
    assert_eq!(result.id, "email_1");
    let request = request.recv().unwrap();
    assert!(request.starts_with("POST /emails HTTP/1.1"));
    assert!(request.contains("authorization: Bearer sn_test_fixture_key"));
    assert!(request.contains("idempotency-key: order-1"));
    assert!(request.contains(r#""scheduled_at":"in 1 hour""#));
}
#[tokio::test]
async fn errors_retain_status_code_and_retry_after_without_retrying() {
    let (origin, request) = fixture(
        "429 Too Many Requests",
        "Retry-After: 7\r\n",
        r#"{"name":"rate_limit_exceeded","message":"Slow down"}"#,
    );
    let error = client(&origin)
        .emails()
        .cancel("email_1")
        .await
        .unwrap_err();
    assert_eq!(error.status, Some(429));
    assert_eq!(error.code, "rate_limit_exceeded");
    assert_eq!(error.retry_after.as_deref(), Some("7"));
    assert!(request
        .recv()
        .unwrap()
        .starts_with("POST /emails/email_1/cancel"));
}
#[tokio::test]
async fn redirects_are_rejected_without_forwarding_credentials() {
    let (origin, _) = fixture(
        "307 Temporary Redirect",
        "Location: https://example.test/stolen\r\n",
        "",
    );
    let error = client(&origin)
        .emails()
        .cancel("email_1")
        .await
        .unwrap_err();
    assert_eq!(error.code, "unexpected_redirect");
}
#[tokio::test]
async fn unsafe_identifier_is_rejected_before_request() {
    let error = client("http://127.0.0.1:9")
        .emails()
        .get("../other")
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_identifier");
}
#[test]
fn unsafe_origins_are_rejected() {
    for origin in [
        "http://example.com",
        "https://user:secret@example.com",
        "https://example.com/path",
        "https://example.com?key=secret",
        "https://example.com/#fragment",
    ] {
        assert!(Sooner::with_options("sn_test", origin, Duration::from_secs(1)).is_err());
    }
}
#[tokio::test]
async fn list_cursor_is_encoded_and_response_is_typed() {
    let (origin, request) = fixture(
        "200 OK",
        "",
        r#"{"object":"list","data":[],"has_more":false}"#,
    );
    let options = sooner_email::ListOptions {
        limit: Some(25),
        after: Some("cursor&limit=1".into()),
    };
    let result = client(&origin).emails().list(&options).await.unwrap();
    assert!(!result.has_more);
    assert!(request
        .recv()
        .unwrap()
        .starts_with("GET /emails?limit=25&after=cursor%26limit%3D1 "));
}
#[tokio::test]
async fn reschedule_uses_patch_and_snake_case() {
    let (origin, request) = fixture("200 OK", "", r#"{"object":"email","id":"email_1"}"#);
    client(&origin)
        .emails()
        .reschedule("email_1", "in 1 hour")
        .await
        .unwrap();
    let request = request.recv().unwrap();
    assert!(request.starts_with("PATCH /emails/email_1 "));
    assert!(request.contains(r#"{"scheduled_at":"in 1 hour"}"#));
}
#[tokio::test]
async fn batch_uses_array_payload_and_returns_ids() {
    let (origin, request) = fixture("200 OK", "", r#"{"data":[{"id":"email_1"}]}"#);
    let result = client(&origin)
        .emails()
        .send_batch(&[SendEmail::default()], Some("batch-1"))
        .await
        .unwrap();
    assert_eq!(result.data[0].id, "email_1");
    let request = request.recv().unwrap();
    assert!(request.starts_with("POST /emails/batch "));
    assert!(request.contains("\r\n\r\n["));
}

#[tokio::test]
async fn get_deserializes_the_email_record() {
    let body = r#"{"object":"email","id":"email_1","from":"sender@example.test","to":["recipient@example.test"],"cc":null,"bcc":null,"reply_to":null,"subject":"Hello","html":null,"text":"Hi","created_at":"2026-11-17T00:00:00Z","scheduled_at":null,"status":"delivered","last_event":"delivered","tags":[]}"#;
    let (origin, request) = fixture("200 OK", "", body);
    let email = client(&origin).emails().get("email_1").await.unwrap();
    assert_eq!(email.text.as_deref(), Some("Hi"));
    assert_eq!(email.status, "delivered");
    assert!(request.recv().unwrap().starts_with("GET /emails/email_1 "));
}

#[tokio::test]
async fn timeouts_are_reported_with_uncertain_write_guidance() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(100));
    });
    let client = Sooner::with_options("sn_test", &origin, Duration::from_millis(20)).unwrap();
    let error = client.emails().cancel("email_1").await.unwrap_err();
    assert_eq!(error.code, "request_timeout");
    assert!(error.message.contains("original idempotency key"));
    server.join().unwrap();
}

#[test]
fn malformed_api_keys_are_rejected() {
    for key in ["sn_bad key", "sn_bad\r\nheader", "re_other", "sn_é", "sn_"] {
        assert!(Sooner::new(key).is_err());
    }
}

#[tokio::test]
async fn oversized_responses_keep_the_http_status() {
    let body = "x".repeat(2 * 1024 * 1024 + 1);
    let (origin, _) = fixture("503 Unavailable", "Retry-After: 8\r\n", &body);
    let error = client(&origin)
        .emails()
        .cancel("email_1")
        .await
        .unwrap_err();
    assert_eq!(error.code, "response_too_large");
    assert_eq!(error.status, Some(503));
    assert_eq!(error.retry_after.as_deref(), Some("8"));
}

#[tokio::test]
async fn malformed_success_is_a_response_error() {
    let (origin, _) = fixture("200 OK", "", "not JSON");
    let error = client(&origin).emails().get("email_1").await.unwrap_err();
    assert_eq!(error.code, "invalid_response");
    assert_eq!(error.status, Some(200));
}

#[tokio::test]
async fn disconnect_after_write_is_not_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0; 4096];
        assert!(stream.read(&mut buffer).unwrap() > 0);
        drop(stream);
        listener.set_nonblocking(true).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(
            listener.accept().is_err(),
            "SDK retried a request after a lost write outcome"
        );
    });
    let error = client(&origin)
        .emails()
        .cancel("email_1")
        .await
        .unwrap_err();
    assert_eq!(error.code, "network_error");
    assert!(error.message.contains("original idempotency key"));
    server.join().unwrap();
}
