""" Settings for the application. """

import secrets

from enum import Enum
from typing import List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.auth.config import AuthSettings


class AuthType(str, Enum):
    DISABLED = "disabled"


def parse_comma_separated_list(v: Optional[str]) -> Optional[List[str]]:
    if v is None:
        return None
    return [item.strip() for item in v.split(",") if item.strip()]


class Settings(BaseSettings):
    """Settings for the application."""

    model_config = SettingsConfigDict(
        env_file=".env", env_ignore_empty=True, extra="ignore"
    )

    # API and Security
    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = secrets.token_urlsafe(32)
    DATABASE_URL: str
    MILVUS_HOST: str = "localhost"
    MILVUS_PORT: int = 19530

    # Authentication
    auth: AuthSettings = AuthSettings()

    # External Services

    ## SLACK
    SLACK_BOT_TOKEN: str
    SLACK_SIGNING_SECRET: str
    SLACK_WORKSPACE: str
    SLACK_CHANNELS: Optional[list[str]] = None
    SLACK_CHANNEL_REGEX_ENABLED: bool = False
    ALLOWED_BOT_APPS: Optional[List[str]] = ["Datadog"]

    ## DATADOG
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

    @field_validator("SLACK_CHANNELS", mode="before")
    @classmethod
    def parse_slack_channels(cls, v):
        return parse_comma_separated_list(v)


settings = Settings()  # type: ignore
