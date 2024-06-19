"""Dependencies for the application."""

from fastapi import Request

from app.managers.notification_manager import NotificationManager


def get_notification_manager(request: Request) -> NotificationManager:
    """Get the notification manager from the application state."""
    return request.app.state.notification_manager
