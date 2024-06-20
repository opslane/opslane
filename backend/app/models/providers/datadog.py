"""Datadog related models."""

from pydantic import BaseModel


class DatadogOrganization(BaseModel):
    """Datadog organization model."""

    id: str
    name: str


class DatadogAlert(BaseModel):
    """Datadog alert model."""

    title: str
    last_updated: str
    event_type: str
    date: str
    body: str
    org: DatadogOrganization
