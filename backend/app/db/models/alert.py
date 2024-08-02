"""Alert related models"""

from datetime import datetime
from typing import List, Optional
from sqlmodel import Field, SQLModel, Column, Enum, JSON, Relationship, String
from sqlalchemy.dialects.postgresql import ARRAY, FLOAT
from pydantic_settings import SettingsConfigDict

from app.schemas.alert import AlertSource, AlertStatus, SeverityLevel


class AlertConfiguration(SQLModel, table=True):
    """A model to store alert configurations (analogous to Datadog's Monitor)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    description: Optional[str] = Field(default=None)
    query: str = Field(description="The condition that triggers the alert")
    provider: AlertSource = Field(sa_column=Column(Enum(AlertSource)))
    provider_id: str = Field(
        unique=True, index=True, description="The ID in the provider's system"
    )
    is_noisy: bool = Field(default=False)
    noisy_reason: Optional[str] = Field(default=None)

    events: List["Alert"] = Relationship(back_populates="configuration")


class Alert(SQLModel, table=True):
    """A model to store normalized alert data from various monitoring systems."""

    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True, description="A brief title of the alert")
    description: str = Field(description="Detailed description of the alert")
    severity: SeverityLevel = Field(sa_column=Column(Enum(SeverityLevel)))
    status: AlertStatus = Field(sa_column=Column(Enum(AlertStatus)))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    alert_source: AlertSource = Field(sa_column=Column(Enum(AlertSource)))
    tags: dict = Field(default={}, sa_column=Column(JSON))
    service: Optional[str] = Field(default=None, sa_column=Column(String))
    env: Optional[str] = Field(default=None, sa_column=Column(String))
    additional_data: dict = Field(default={}, sa_column=Column(JSON))
    provider_event_id: str = Field(description="The event ID in the provider's system")
    provider_aggregation_key: Optional[str] = Field(
        description="The aggregation key in the provider's system"
    )
    provider_cycle_key: Optional[str] = Field(
        description="The cycle key in the provider's system"
    )
    duration_seconds: Optional[int] = Field(
        default=None, description="The duration of the alert in seconds"
    )
    embedding: Optional[List[float]] = Field(sa_column=Column(ARRAY(FLOAT)))

    configuration_id: str = Field(
        default=None, foreign_key="alertconfiguration.provider_id"
    )

    configuration: Optional[AlertConfiguration] = Relationship(back_populates="events")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_ignore_empty=True,
        extra="ignore",
        arbitrary_types_allowed = True
    )
