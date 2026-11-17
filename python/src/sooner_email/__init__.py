"""First-party Python SDK for the Sooner email API."""
from .client import Sooner, SoonerApiError
from .types import Attachment, BatchResult, Email, EmailId, EmailPage, SendEmail, Tag, Template

__version__ = "0.1.0"
__all__ = ["Sooner", "SoonerApiError", "Attachment", "BatchResult", "Email", "EmailId", "EmailPage", "SendEmail", "Tag", "Template"]
