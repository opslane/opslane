"""Datadog integration for alerting."""

from datetime import datetime

from app.db.models.alert import Alert, AlertSource
from app.db.models.providers.datadog import DatadogAlert
from .base import BaseIntegration


class DatadogIntegration(BaseIntegration):
    """Integration for Datadog."""

    WEBHOOK_PAYLOAD = {
        "alert_id": "$ALERT_ID",
        "event_message": "$TEXT_ONLY_MSG",
        "title": "$EVENT_TITLE",
        "url": "$LINK",
        "alert_transition": "$ALERT_TRANSITION",
        "hostname": "$HOSTNAME",
        "org": {"id": "$ORG_ID", "name": "$ORG_NAME"},
        "priority": "$PRIORITY",
        "snapshot": "$SNAPSHOT",
        "alert_query": "$ALERT_QUERY",
        "alert_scope": "$ALERT_SCOPE",
        "alert_status": "$ALERT_STATUS",
        "event_type": "$EVENT_TYPE",
        "event_id": "$ID",
        "alert_metric": "$ALERT_METRIC",
        "alert_priority": "$ALERT_PRIORITY",
        "alert_title": "$ALERT_TITLE",
        "alert_type": "$ALERT_TYPE",
        "event_msg": "$EVENT_MSG",
        "tags": "$TAGS",
        "last_updated": "$LAST_UPDATED",
        "date": "$DATE",
    }

    def _map_severity(self, event_type: str) -> str:
        """Map Datadog event type to a severity level."""
        # Example mapping, needs to be adjusted according to actual use case
        return {"query_alert_monitor": "high", "log_alert": "medium"}.get(
            event_type, "unknown"
        )

    def convert_timestamp(self, timestamp: str) -> str:
        """Convert Datadog timestamp to a human-readable format."""
        return datetime.fromtimestamp(int(timestamp) / 1000).isoformat()

    def normalize_alert(self, alert: dict) -> Alert:
        """Format alert to be sent to notifiers."""
        datadog_alert = DatadogAlert(**alert)

        # Create an instance of the Alert model
        normalized_alert = Alert(
            title=datadog_alert.title,
            description=datadog_alert.event_message,
            severity=self._map_severity(datadog_alert.event_type),
            status="new",
            created_at=self.convert_timestamp(datadog_alert.date),
            updated_at=self.convert_timestamp(datadog_alert.last_updated),
            alert_source=AlertSource.DATADOG,
            tags=datadog_alert.tags,
            additional_data={
                "url": datadog_alert.url,
                "alert_transition": datadog_alert.alert_transition,
                "hostname": datadog_alert.hostname,
                "org_id": datadog_alert.org.id,
                "org_name": datadog_alert.org.name,
                "priority": datadog_alert.priority,
                "snapshot": datadog_alert.snapshot,
                "alert_query": datadog_alert.alert_query,
                "alert_scope": datadog_alert.alert_scope,
                "alert_status": datadog_alert.alert_status,
                "event_type": datadog_alert.event_type,
                "event_id": datadog_alert.event_id,
                "alert_metric": datadog_alert.alert_metric,
                "alert_priority": datadog_alert.alert_priority,
                "alert_title": datadog_alert.alert_title,
                "alert_type": datadog_alert.alert_type,
                "event_msg": datadog_alert.event_msg,
                "last_updated": datadog_alert.last_updated,
            },
        )
        return normalized_alert

    def enrich_alert(self, alert: Alert) -> Alert:
        """Enrich alert with additional data."""
        return alert
