# Sooner Python SDK

First-party Python client for sending, listing, retrieving, rescheduling, and canceling Sooner emails. Requires Python 3.11 or newer and has no runtime dependencies.

```sh
python -m pip install sooner-email==0.1.0
```

```python
import os
from sooner_email import Sooner, SoonerApiError

sooner = Sooner(os.environ["SOONER_API_KEY"])

try:
    email = sooner.emails.send({
        "from": "Acme <hello@mail.example.com>",
        "to": ["ada@example.com"],
        "subject": "Welcome",
        "text": "Thanks for joining.",
    }, idempotency_key="welcome-user-42")
    print(email["id"])
except SoonerApiError as error:
    print(error.status, error.code, error.retry_after)
```

All fields use the API's snake_case spellings. API keys stay on your server. `base_url` accepts an HTTPS origin, with HTTP permitted for loopback development endpoints. HTTP redirects are rejected to protect the bearer key.

```python
sooner.emails.send_batch([
    {"from": "hello@mail.example.com", "to": "ada@example.com", "subject": "Hello", "text": "Hi"},
], idempotency_key="batch-42")
page = sooner.emails.list(limit=20)
email = sooner.emails.get("EMAIL_ID")
sooner.emails.reschedule("EMAIL_ID", "2026-12-01T09:00:00Z")
sooner.emails.cancel("EMAIL_ID")
```

Management endpoints require a Full access key. Batches reject attachments and scheduling. Sending-domain verification, quotas, message limits, and permissions are enforced by the API.

API failures raise `SoonerApiError` with `status`, `code`, and the raw `retry_after` HTTP header. Network failures use status `0` with `network_error` or `timeout`. Malformed or oversized responses raise `invalid_response` or `response_too_large`. Requests are attempted once. A network failure or timeout can happen after acceptance. Retry sends with the original payload and idempotency key to preserve deduplication.

`timeout` defaults to 30 seconds and bounds each blocking HTTP operation. A slowly delivered response can take longer than this setting overall. The client caps response bodies at 2 MiB. Use pagination to bound list responses.

The SDK is MIT licensed. Its source and release history are maintained in [sooner-sdks](https://github.com/Quad-Labs-LLC/sooner-sdks), with the API guide at [Sooner Python documentation](https://sooner.dev/docs/sdks/python).

Run the offline contract checks from this package directory with `PYTHONPATH=src python -m unittest discover -s tests`. Build wheel and source distributions with `python -m build` in a packaging environment that has the build frontend and setuptools installed. The distribution includes inline types and the `py.typed` marker.
