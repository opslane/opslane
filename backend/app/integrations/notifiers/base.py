"""Base class for notifiers."""

from abc import ABC, abstractmethod

from app.db.models.alert import Alert


class BaseNotifier(ABC):
    """Base class for notifiers."""

    @abstractmethod
    def notify(self, alert: Alert):
        """Send notification with the given message."""
        raise NotImplementedError("Subclasses must implement this method")
