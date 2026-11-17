"""JSON types accepted and returned by the Sooner emails API."""
from typing import NotRequired, TypedDict


class Tag(TypedDict):
    name: str
    value: str


class Attachment(TypedDict, total=False):
    filename: str
    content: str | list[int]
    path: str
    content_type: str
    content_id: str


class Template(TypedDict):
    id: str
    variables: NotRequired[dict[str, str | int | float]]


SendEmail = TypedDict("SendEmail", {
    "from": NotRequired[str],
    "to": str | list[str],
    "subject": NotRequired[str],
    "html": NotRequired[str],
    "text": NotRequired[str],
    "cc": NotRequired[str | list[str]],
    "bcc": NotRequired[str | list[str]],
    "reply_to": NotRequired[str | list[str]],
    "headers": NotRequired[dict[str, str]],
    "tags": NotRequired[list[Tag]],
    "attachments": NotRequired[list[Attachment]],
    "template": NotRequired[Template],
    "scheduled_at": NotRequired[str],
    "topic_id": NotRequired[str],
})


class EmailId(TypedDict):
    id: str


class BatchResult(TypedDict):
    data: list[EmailId]


Email = TypedDict("Email", {
    "object": str,
    "id": str,
    "from": str,
    "to": list[str],
    "subject": str,
    "status": str,
    "created_at": str,
    "html": str | None,
    "text": str | None,
    "cc": list[str] | None,
    "bcc": list[str] | None,
    "reply_to": list[str] | None,
    "tags": list[Tag],
    "scheduled_at": str | None,
    "last_event": str,
    "error": NotRequired[str],
})

class EmailPage(TypedDict):
    object: str
    data: list[Email]
    has_more: bool
