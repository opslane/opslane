""" Settings for the application. """

import secrets

from enum import Enum
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.auth.config import AuthSettings


class AuthType(str, Enum):
    DISABLED = "disabled"


class Settings(BaseSettings):
    """Settings for the application."""

    model_config = SettingsConfigDict(
        env_file=".env", env_ignore_empty=True, extra="ignore"
    )

    # API and Security
    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = secrets.token_urlsafe(32)
    DATABASE_URL: str

    # Authentication
    auth: AuthSettings = AuthSettings()

    # External Services
    SLACK_BOT_TOKEN: str
    SLACK_SIGNING_SECRET: str
    DATADOG_API_KEY: str
    DATADOG_APP_KEY: str

    # AI and Machine Learning
    PREDICTION_CONFIDENCE_THRESHOLD: float = 0.5
    LLM_PROVIDER: str = "ollama"
    LLM_API_KEY: Optional[str] = None
    LLM_API_BASE: Optional[str] = None

    # Codebase
    GITHUB_TOKEN: Optional[str] = None
    GITHUB_REPO: Optional[str] = None

    # Miscellaneous
    ANONYMIZED_TELEMETRY: bool = True


settings = Settings()  # type: ignore
