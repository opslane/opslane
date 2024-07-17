"""Datadog related models."""

from pydantic import BaseModel


class DatadogOrganization(BaseModel):
    """Datadog organization model."""

    id: str
    name: str


class DatadogAlert(BaseModel):
    """Datadog alert model."""

    alert_id: str
    event_message: str
    title: str
    url: str
    alert_transition: str
    hostname: str
    org: DatadogOrganization
    priority: str
    snapshot: str
    alert_query: str
    alert_scope: str
    alert_status: str
    event_type: str
    event_id: str
    alert_metric: str
    alert_priority: str
    alert_title: str
    alert_type: str
    event_msg: str
    tags: str
    last_updated: str
    date: str
    aggregation_key: str
    alert_cycle_key: str
