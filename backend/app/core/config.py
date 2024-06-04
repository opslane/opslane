""" Settings for the application. """

import secrets

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Settings for the application."""

    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = secrets.token_urlsafe(32)


settings = Settings()  # type: ignore
