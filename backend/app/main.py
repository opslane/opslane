"""Main application."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.api.auth_check import enforce_authentication
from app.core.config import settings
from app.slack.bot import slack_handler


def create_app() -> FastAPI:
    """Create the FastAPI application."""

    app = FastAPI(title="Opslane API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],  # Add your frontend URL here
        allow_credentials=True,
        allow_methods=["*"],  # Allows all methods
        allow_headers=["*"],  # Allows all headers
    )

    # Include API routers
    app.include_router(api_router, prefix=settings.API_V1_STR)

    @app.post("/slack/events")
    async def slack_events(request: Request):
        return await slack_handler.handle(request)

    # Enforce authentication on routes
    enforce_authentication(app)

    return app
