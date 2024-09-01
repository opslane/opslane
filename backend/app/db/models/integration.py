"""Models for integration and integration credentials."""

from enum import Enum
from typing import Optional, Dict, Any

from sqlalchemy import JSON, Column, ForeignKey, UniqueConstraint
from sqlmodel import Field, SQLModel

from app.db.models.base import Base


class IntegrationType(str, Enum):
    DATADOG = "datadog"
    SENTRY = "sentry"
    PAGERDUTY = "pagerduty"


class Integration(Base, table=True):
    name: str = Field(index=True)
    description: Optional[str] = None
    type: IntegrationType
    configuration: Dict[str, Any] = Field(default={}, sa_column=Column(JSON))
    credential_schema: Dict[str, Any] = Field(default={}, sa_column=Column(JSON))
    is_active: bool = Field(default=True)
    credential_id: Optional[int] = Field(
        default=None, foreign_key="integrationcredential.id"
    )

    __table_args__ = (
        UniqueConstraint("tenant_id", "type", name="uq_tenant_integration_type"),
    )


class IntegrationCredential(Base, table=True):
    integration_id: int = Field(foreign_key="integration.id")
    encrypted_credentials: Dict[str, Any] = Field(default={}, sa_column=Column(JSON))
