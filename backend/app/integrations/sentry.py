from .base import BaseIntegration


class SentryIntegration(BaseIntegration):
    """Integration for Sentry."""

    def process_alert(self, alert: dict):
        """Process received Sentry alert."""
        print("Processing Sentry alert:", alert)
