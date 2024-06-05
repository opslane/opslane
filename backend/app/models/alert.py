"""Alert Model"""

from sqlmodel import Field, Relationship, SQLModel


class Alert(SQLModel, table=True):
    """Alert model."""

    id: int | None = Field(default=None, primary_key=True)
    name: str
    description: str
    severity: str
    status: str
    created_at: str
    updated_at: str
