import enum
from sqlmodel import Field, SQLModel, Column, Enum, JSON


class SeverityLevel(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class AlertSource(str, enum.Enum):
    DATADOG = "Datadog"


class Alert(SQLModel, table=True):
    """A model to store normalized alert data from various monitoring systems."""

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(index=True, description="A brief title of the alert")
    description: str = Field(description="Detailed description of the alert")
    severity: SeverityLevel = Field(
        sa_column=Column(Enum(SeverityLevel)),
        description="Severity level of the alert",
    )
    status: str = Field(
        index=True, description="Current status of the alert (e.g., open, resolved)"
    )
    created_at: str = Field(description="Timestamp when the alert was created")
    updated_at: str = Field(description="Timestamp when the alert was last updated")
    alert_source: AlertSource = Field(
        sa_column=Column(Enum(AlertSource)),
        description="The system from which the alert originated",
    )
    tags: JSON = Field(
        default="[]",
        sa_column=Column(JSON),
        description="A JSON array of tags associated with the alert",
    )
    additional_data: JSON = Field(
        default="{}",
        sa_column=Column(JSON),
        description="A JSON object to store additional, system-specific data",
    )

    class Config:
        arbitrary_types_allowed = True
