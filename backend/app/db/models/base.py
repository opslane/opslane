"""Base model and utility functions for database operations."""

import uuid
from datetime import datetime
from typing import Optional, Any

from sqlmodel import Field, SQLModel
from sqlalchemy.ext.declarative import declared_attr
from sqlalchemy.orm import Session


class Base(SQLModel):
    @declared_attr
    def __tablename__(self):
        return self.__name__.lower()

    id: int = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(
        default_factory=datetime.utcnow,
        nullable=False,
        sa_column_kwargs={"onupdate": datetime.utcnow},
    )
    tenant_id: uuid.UUID = Field(index=True, foreign_key="tenant.id")

    @classmethod
    def create(cls, db: Session, **kwargs: Any) -> Any:
        """Create a new record and save it the database."""
        instance = cls(**kwargs)
        db.add(instance)
        db.commit()
        db.refresh(instance)
        return instance

    def update(self, db: Session, **kwargs: Any) -> Any:
        """Update specific fields of a record."""
        for attr, value in kwargs.items():
            setattr(self, attr, value)
        db.add(self)
        db.commit()
        db.refresh(self)
        return self

    def delete(self, db: Session) -> None:
        """Remove the record from the database."""
        db.delete(self)
        db.commit()

    @classmethod
    def get_by_id(cls, db: Session, record_id: Any) -> Optional[Any]:
        """Get record by ID."""
        return db.query(cls).filter(cls.id == record_id).first()


def reference_col(
    tablename: str, nullable: bool = False, pk_name: str = "id", **kwargs: Any
) -> Any:
    """Column that adds primary key foreign key reference."""
    return Field(foreign_key=f"{tablename}.{pk_name}", nullable=nullable, **kwargs)
