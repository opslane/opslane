""" Settings for the application. """

import secrets

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    """Settings for the application."""

    model_config = SettingsConfigDict(
        env_file=".env", env_ignore_empty=True, extra="ignore"
    )

    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = secrets.token_urlsafe(32)
    DATABASE_URL: str
    SLACK_BOT_TOKEN: str
    SLACK_SIGNING_SECRET: str
    DATADOG_API_KEY: str
    DATADOG_APP_KEY: str
    DATADOG_BOT_SLACK_ID: str

    PREDICTION_CONFIDENCE_THRESHOLD: float = 0.5
    LLM_PROVIDER: str = "ollama"
    LLM_API_KEY: Optional[str] = None
    LLM_API_BASE: Optional[str] = None


settings = Settings()  # type: ignore
