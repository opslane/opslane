"""Main application."""

from fastapi import FastAPI

from app.api.main import api_router
from app.core.config import settings


def create_app() -> FastAPI:
    """Create the FastAPI application."""

    app = FastAPI(title="Opslane API", version="0.1.0")

    # Include API routers
    app.include_router(api_router, prefix=settings.API_V1_STR)

    # Additional configuration can go here

    return app
