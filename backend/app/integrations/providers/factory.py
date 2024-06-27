"""Integration source factory to get integration class for a given source."""

import importlib
from app.integrations.providers.base import BaseIntegration


class IntegrationSourceFactory:
    """Factory class to get integration class for a given source."""

    @classmethod
    def get_integration(cls, source: str):
        """Get integration class for a given source."""
        try:
            # Convert source to proper class name convention
            class_name = f"{source.capitalize()}Integration"
            # Dynamically import the module where the class should be located
            module = importlib.import_module(
                f"app.integrations.providers.{source.lower()}"
            )
            # Get the class from the module
            integration_class = getattr(module, class_name)
            if issubclass(integration_class, BaseIntegration):
                return integration_class()

            raise TypeError(
                f"Integration class {class_name} must inherit from BaseIntegration"
            )
        except (ImportError, AttributeError, TypeError) as e:
            raise ValueError(
                f"No integration found for source: {source}. Error: {e}"
            ) from e
