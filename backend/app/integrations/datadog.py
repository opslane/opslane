"""Datadog integration for alerting."""

from datetime import datetime

from app.models.alert import Alert
from app.models.providers.datadog import DatadogAlert
from .base import BaseIntegration


class DatadogIntegration(BaseIntegration):
    """Integration for Datadog."""

    def _map_severity(self, event_type: str) -> str:
        """Map Datadog event type to a severity level."""
        # Example mapping, needs to be adjusted according to actual use case
        return {"query_alert_monitor": "high", "log_alert": "medium"}.get(
            event_type, "unknown"
        )

    def convert_timestamp(self, timestamp: str) -> str:
        """Convert Datadog timestamp to a human-readable format."""
        return datetime.fromtimestamp(int(timestamp) / 1000).isoformat()

    def normalize_alert(self, alert: dict) -> str:
        """Format alert to be sent to notifiers."""
        datadog_alert = DatadogAlert(**alert)

        # Create an instance of the Alert model
        normalized_alert = Alert(
            name=datadog_alert.title,
            description=datadog_alert.body,
            severity=self._map_severity(datadog_alert.event_type),
            status="new",  # Assuming a new alert status
            created_at=self.convert_timestamp(datadog_alert.date),
            updated_at=self.convert_timestamp(datadog_alert.last_updated),
        )
        return normalized_alert

    def enrich_alert(self, alert: Alert) -> Alert:
        """Enrich alert with additional data."""
        # alert["custom_field"] = "enriched"
        return alert
