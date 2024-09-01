"""Base class for integrations."""

from abc import ABC, abstractmethod
from typing import Any, Dict

from pydantic import BaseModel

from app.db.models.alert import Alert
from app.schemas.alert import AlertSchema
from app.services.alert import store_alert_in_db


class BaseIntegration(ABC):
    """Base class for integrations."""

    @property
    @abstractmethod
    def credential_schema(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    def validate_credentials(self, credentials: Dict[str, str]) -> None:
        pass

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


class CredentialSchema(BaseModel):
    pass
