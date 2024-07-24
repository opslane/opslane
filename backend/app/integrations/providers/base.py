"""Base class for integrations."""

from abc import ABC, abstractmethod

from app.db.models.alert import Alert
from app.schemas.alert import AlertSchema
from app.services.alert import store_alert_in_db


class BaseIntegration(ABC):
    """Base class for integrations."""

    @abstractmethod
    def normalize_alert(self, alert: dict) -> AlertSchema:
        """Format alert to be sent to notifiers."""
        raise NotImplementedError("normalize_alert not implemented")

    def store_alert(self, alert: AlertSchema) -> AlertSchema:
        """Store alert in the database."""

        return store_alert_in_db(alert)

    def process_alert(self, alert: dict) -> Alert:
        """Process received alert."""
        normalized_alert = self.normalize_alert(alert)
        stored_alert = self.store_alert(normalized_alert)
        return stored_alert
