""" Settings for the application. """

import secrets
from enum import Enum
from typing import List, Optional

from cryptography.fernet import Fernet
from pydantic import field_validator
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
    ENCRYPTION_KEY: str = Fernet.generate_key()
    MILVUS_HOST: str = "localhost"
    MILVUS_PORT: int = 19530
    TENANT_NAME: str = "Opslane"

    # Authentication
    auth: AuthSettings = AuthSettings()

    # External Services

    ## SLACK
    SLACK_BOT_TOKEN: str
    SLACK_SIGNING_SECRET: str
    SLACK_WORKSPACE: str
    SLACK_CHANNELS: Optional[list[str]] = None
    SLACK_CHANNEL_REGEX_ENABLED: bool = False
    ALLOWED_BOT_APPS: Optional[List[str]] = ["PagerDuty"]
    SLACK_COLLECTION_NAME: str = "slack_messages"

    ## DATADOG
    DATADOG_API_KEY: str
    DATADOG_APP_KEY: str

    # PAGERDUTY
    PAGERDUTY_API_TOKEN: str

    # GITHUB
    GITHUB_REPO: str = "abhishekray07/stock-trader"
    GITHUB_TOKEN: str

    # LLM
    PREDICTION_CONFIDENCE_THRESHOLD: float = 0.5
    ANTHROPIC_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None
    IS_LANGFUSE_ENABLED: bool = False
    LANGFUSE_PUBLIC_KEY: Optional[str] = None
    LANGFUSE_SECRET_KEY: Optional[str] = None
    LANGFUSE_HOST: Optional[str] = "https://us.cloud.langfuse.com"

    # Miscellaneous
    ANONYMIZED_TELEMETRY: bool = True

    @field_validator("SLACK_CHANNELS", mode="before")
    @classmethod
    def parse_slack_channels(cls, v):
        return parse_comma_separated_list(v)


settings = Settings()  # type: ignore
