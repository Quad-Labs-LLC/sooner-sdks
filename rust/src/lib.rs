//! Typed asynchronous client for Sooner's email API.
//! Requests run once. Reuse the same idempotency key after an uncertain send.

use reqwest::{header, Method, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{collections::HashMap, fmt, time::Duration};

pub const DEFAULT_BASE_URL: &str = "https://api.sooner.dev";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct SoonerError {
    /// HTTP status, or None when no response was received.
    pub status: Option<u16>,
    /// API error name or a transport/configuration error code.
    pub code: String,
    pub message: String,
    /// Raw Retry-After value, which can be seconds or an HTTP date.
    pub retry_after: Option<String>,
}
impl fmt::Display for SoonerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for SoonerError {}
fn local_error(code: &str, message: &str) -> SoonerError {
    SoonerError {
        status: None,
        code: code.into(),
        message: message.into(),
        retry_after: None,
    }
}
fn transport_error(error: reqwest::Error) -> SoonerError {
    if error.is_timeout() {
        local_error("request_timeout", "Request timed out. A write outcome may be unknown. Reuse the original idempotency key.")
    } else {
        local_error(
            "network_error",
            "Request failed. A write outcome may be unknown. Reuse the original idempotency key.",
        )
    }
}

#[derive(Clone)]
pub struct Sooner {
    client: reqwest::Client,
    base_url: Url,
}
impl Sooner {
    pub fn new(api_key: impl AsRef<str>) -> Result<Self, SoonerError> {
        Self::with_options(api_key, DEFAULT_BASE_URL, Duration::from_secs(30))
    }
    /// HTTPS origins, or HTTP loopback origins for local development, are accepted.
    pub fn with_options(
        api_key: impl AsRef<str>,
        base_url: &str,
        timeout: Duration,
    ) -> Result<Self, SoonerError> {
        let key = api_key.as_ref();
        if !key.starts_with("sn_")
            || !(4..=203).contains(&key.len())
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(local_error("invalid_api_key", "Provide a Sooner API key."));
        }
        if base_url.trim() != base_url {
            return Err(local_error(
                "invalid_base_url",
                "Use an origin without surrounding whitespace.",
            ));
        }
        let mut base = Url::parse(base_url)
            .map_err(|_| local_error("invalid_base_url", "Provide an HTTPS API origin."))?;
        let host = base.host_str().unwrap_or("").trim_matches(['[', ']']);
        let loopback = host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if base.host().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.path() != "/"
            || !(base.scheme() == "https" || (base.scheme() == "http" && loopback))
        {
            return Err(local_error("invalid_base_url", "Use an HTTPS origin without credentials, path, query, or fragment. HTTP loopback is supported locally."));
        }
        if timeout.is_zero() {
            return Err(local_error(
                "invalid_timeout",
                "Timeout must be greater than zero.",
            ));
        }
        base.set_path("/");
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| local_error("invalid_api_key", "Provide a valid Sooner API key."))?;
        authorization.set_sensitive(true);
        let mut headers = header::HeaderMap::new();
        headers.insert(header::AUTHORIZATION, authorization);
        headers.insert(
            header::ACCEPT,
            header::HeaderValue::from_static("application/json"),
        );
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .user_agent("sooner-rust/0.1.0")
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(transport_error)?;
        Ok(Self {
            client,
            base_url: base,
        })
    }
    pub fn emails(&self) -> Emails<'_> {
        Emails { client: self }
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        idempotency_key: Option<&str>,
    ) -> Result<T, SoonerError> {
        let url = self
            .base_url
            .join(path)
            .map_err(|_| local_error("invalid_path", "Invalid API path."))?;
        let mut request = self.client.request(method, url);
        if let Some(key) = idempotency_key {
            if key.is_empty()
                || key.len() > 256
                || !key.is_ascii()
                || key.bytes().any(|byte| byte < 32 || byte == 127)
            {
                return Err(local_error(
                    "invalid_idempotency_key",
                    "Use a printable ASCII idempotency key of 1 to 256 characters.",
                ));
            }
            request = request.header("idempotency-key", key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(transport_error)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if status.is_redirection() {
            return Err(SoonerError {
                status: Some(status.as_u16()),
                code: "unexpected_redirect".into(),
                message: "The API returned a redirect. The request was not forwarded.".into(),
                retry_after,
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(SoonerError {
                status: Some(status.as_u16()),
                code: "response_too_large".into(),
                message: "The API response exceeded the SDK response limit.".into(),
                retry_after,
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|cause| {
            let mut error = transport_error(cause);
            error.status = Some(status.as_u16());
            error.retry_after = retry_after.clone();
            error
        })? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(SoonerError {
                    status: Some(status.as_u16()),
                    code: "response_too_large".into(),
                    message: "The API response exceeded the SDK response limit.".into(),
                    retry_after,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let data = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
            return Err(SoonerError {
                status: Some(status.as_u16()),
                code: data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("api_error")
                    .into(),
                message: data
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Sooner rejected the request.")
                    .into(),
                retry_after,
            });
        }
        serde_json::from_slice(&bytes).map_err(|_| SoonerError {
            status: Some(status.as_u16()),
            code: "invalid_response".into(),
            message: "Sooner returned an invalid JSON response.".into(),
            retry_after,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Addresses {
    One(String),
    Many(Vec<String>),
}
impl From<&str> for Addresses {
    fn from(value: &str) -> Self {
        Self::One(value.into())
    }
}
impl From<String> for Addresses {
    fn from(value: String) -> Self {
        Self::One(value)
    }
}
impl From<Vec<String>> for Addresses {
    fn from(value: Vec<String>) -> Self {
        Self::Many(value)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub name: String,
    pub value: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub variables: HashMap<String, TemplateValue>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TemplateValue {
    Text(String),
    Number(serde_json::Number),
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Attachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// Base64 encoded file contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Default)]
pub struct SendEmail {
    pub to: Option<Addresses>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cc: Option<Addresses>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bcc: Option<Addresses>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Addresses>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<Template>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<Tag>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}
#[derive(Debug, Deserialize)]
pub struct EmailId {
    pub id: String,
}
#[derive(Debug, Deserialize)]
pub struct BatchResult {
    pub data: Vec<EmailId>,
}
#[derive(Debug, Deserialize)]
pub struct Email {
    pub id: String,
    pub object: String,
    pub from: String,
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub bcc: Option<Vec<String>>,
    pub reply_to: Option<Vec<String>>,
    pub subject: String,
    pub html: Option<String>,
    pub text: Option<String>,
    pub created_at: String,
    pub scheduled_at: Option<String>,
    pub status: String,
    pub last_event: String,
    #[serde(default)]
    pub tags: Vec<Tag>,
    pub error: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct EmailList {
    pub object: String,
    pub data: Vec<Email>,
    pub has_more: bool,
}
#[derive(Debug, Default)]
pub struct ListOptions {
    pub limit: Option<u8>,
    pub after: Option<String>,
}

pub struct Emails<'a> {
    client: &'a Sooner,
}
fn email_path(id: &str) -> Result<String, SoonerError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(local_error(
            "invalid_identifier",
            "Use an email ID without paths or dot segments.",
        ));
    }
    Ok(format!("emails/{id}"))
}
fn payload<T: Serialize>(data: &T) -> Result<serde_json::Value, SoonerError> {
    serde_json::to_value(data)
        .map_err(|_| local_error("invalid_payload", "Could not serialize request payload."))
}
impl Emails<'_> {
    pub async fn send(
        &self,
        email: &SendEmail,
        idempotency_key: Option<&str>,
    ) -> Result<EmailId, SoonerError> {
        self.client
            .request(
                Method::POST,
                "emails",
                Some(payload(email)?),
                idempotency_key,
            )
            .await
    }
    pub async fn send_batch(
        &self,
        emails: &[SendEmail],
        idempotency_key: Option<&str>,
    ) -> Result<BatchResult, SoonerError> {
        self.client
            .request(
                Method::POST,
                "emails/batch",
                Some(payload(&emails)?),
                idempotency_key,
            )
            .await
    }
    pub async fn get(&self, id: &str) -> Result<Email, SoonerError> {
        self.client
            .request(Method::GET, &email_path(id)?, None, None)
            .await
    }
    pub async fn list(&self, options: &ListOptions) -> Result<EmailList, SoonerError> {
        if options
            .limit
            .is_some_and(|limit| !(1..=100).contains(&limit))
        {
            return Err(local_error(
                "invalid_limit",
                "Use a list limit between 1 and 100.",
            ));
        }
        let mut url = self.client.base_url.join("emails").expect("fixed API path");
        if let Some(limit) = options.limit {
            url.query_pairs_mut()
                .append_pair("limit", &limit.to_string());
        }
        if let Some(after) = &options.after {
            url.query_pairs_mut().append_pair("after", after);
        }
        let path = format!(
            "emails{}",
            url.query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        );
        self.client.request(Method::GET, &path, None, None).await
    }
    pub async fn reschedule(&self, id: &str, scheduled_at: &str) -> Result<EmailId, SoonerError> {
        self.client
            .request(
                Method::PATCH,
                &email_path(id)?,
                Some(serde_json::json!({"scheduled_at": scheduled_at})),
                None,
            )
            .await
    }
    pub async fn cancel(&self, id: &str) -> Result<EmailId, SoonerError> {
        self.client
            .request(
                Method::POST,
                &format!("{}/cancel", email_path(id)?),
                None,
                None,
            )
            .await
    }
}
