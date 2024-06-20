"""Base class for integrations."""

from abc import ABC, abstractmethod

from app.models.alert import Alert


class BaseIntegration(ABC):
    """Base class for integrations."""

    @abstractmethod
    def normalize_alert(self, alert: dict) -> Alert:
        """Format alert to be sent to notifiers."""
        raise NotImplementedError("format_alert not implemented")

    @abstractmethod
    def enrich_alert(self, alert: Alert) -> Alert:
        """Enrich alert with additional data."""
        raise NotImplementedError("enrich_alert not implemented")

    def store_alert(self, alert: dict):
        """Store alert in the database."""
        print("storing alert to db:", alert)

    def process_alert(self, alert: dict):
        """Process received alert."""
        normalized_alert = self.normalize_alert(alert)
        enriched_alert = self.enrich_alert(normalized_alert)
        self.store_alert(enriched_alert)
        return enriched_alert
