"""This module contains the NotificationManager class."""


class NotificationManager:
    """Responsible for managing the notification system."""

    def __init__(self):
        self.notifiers = []

    def register_notifier(self, notifier):
        """Register a notifier."""
        self.notifiers.append(notifier)

    def send_notifications(self, message: dict):
        """Send notifications to all registered notifiers."""
        for notifier in self.notifiers:
            notifier.notify(message)
