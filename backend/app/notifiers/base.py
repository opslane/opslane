"""Base class for notifiers."""

from abc import ABC, abstractmethod


class BaseNotifier(ABC):
    """Base class for notifiers."""

    @abstractmethod
    def notify(self, message: str):
        """Send notification with the given message."""
        raise NotImplementedError("Subclasses must implement this method")
