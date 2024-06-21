"""Base class for integrations."""

from abc import ABC, abstractmethod
from sqlmodel import Session

from app.core.db import engine
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

    def store_alert(self, alert: Alert):
        """Store alert in the database."""
        with Session(engine) as session:
            session.add(alert)
            session.commit()
            print("Alert stored in the database!")

    def process_alert(self, alert: dict):
        """Process received alert."""
        normalized_alert = self.normalize_alert(alert)
        enriched_alert = self.enrich_alert(normalized_alert)
        self.store_alert(enriched_alert)
        return enriched_alert
