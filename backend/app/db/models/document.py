from sqlmodel import SQLModel, Field, Column
from datetime import datetime
from typing import Optional, List, Dict
from sqlalchemy.dialects.postgresql import ARRAY, FLOAT, JSONB
from enum import Enum as PyEnum


class DocumentSource(str, PyEnum):
    SLACK = "slack"


class Document(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    external_id: str = Field(index=True, unique=True)
    source: DocumentSource
    title: Optional[str] = Field(default=None, index=True)
    content: str
    doc_metadata: Dict = Field(default={}, sa_column=Column(JSONB))
    embedding: Optional[List[float]] = Field(sa_column=Column(ARRAY(FLOAT)))
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
