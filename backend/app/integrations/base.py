"""Base class for integrations."""

from abc import ABC, abstractmethod


class BaseIntegration(ABC):
    """Base class for integrations."""

    @abstractmethod
    def process_alert(self, alert: dict):
        pass
