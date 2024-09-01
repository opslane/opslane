"""Initialize the database connection and session."""

from sqlmodel import create_engine, Session
from app.core.config import settings

engine = create_engine(str(settings.DATABASE_URL), pool_pre_ping=True)


def get_session():
    """
    Create and yield a database session.

    This function creates a new database session using the global engine,
    yields it for use in a context manager, and automatically closes
    the session when the context is exited.

    Yields:
        Session: A SQLModel Session object connected to the database.
    """
    with Session(engine) as session:
        yield session


SessionLocal = Session(engine)
