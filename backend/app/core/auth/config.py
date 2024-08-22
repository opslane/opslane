"""Auth Configurations."""

from enum import Enum
from pydantic_settings import BaseSettings


class AuthType(str, Enum):
    DISABLED = "disabled"
    # Add more types in the future, e.g., GOOGLE_OAUTH = "google_oauth"


class AuthSettings(BaseSettings):
    AUTH_TYPE: AuthType = AuthType.DISABLED


auth_settings = AuthSettings()
