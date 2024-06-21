"""This module contains the NotificationManager class."""

from app.models.alert import Alert


class NotificationManager:
    """Responsible for managing the notification system."""

    def __init__(self):
        self.notifiers = []

    def register_notifier(self, notifier):
        """Register a notifier."""
        self.notifiers.append(notifier)

    def send_notifications(self, alert: Alert):
        """Send notifications to all registered notifiers."""
        for notifier in self.notifiers:
            notifier.notify(alert)
