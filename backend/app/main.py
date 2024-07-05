"""Main application."""

from fastapi import FastAPI, Request

from app.api.main import api_router
from app.core.config import settings
from app.integrations.notifiers.slack import SlackNotifier
from app.managers.notification_manager import NotificationManager
from app.slack import slack_handler


def create_app() -> FastAPI:
    """Create the FastAPI application."""

    app = FastAPI(title="Opslane API", version="0.1.0")

    # Include API routers
    app.include_router(api_router, prefix=settings.API_V1_STR)

    # Additional configuration can go here
    slack_notifier = SlackNotifier()
    notification_manager = NotificationManager()
    notification_manager.register_notifier(slack_notifier)

    app.state.notification_manager = notification_manager

    @app.post("/slack/events")
    async def slack_events(request: Request):
        return await slack_handler.handle(request)

    return app
