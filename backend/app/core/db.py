"""Initialize the database connection and session."""

from sqlmodel import create_engine

from app.core.config import settings

engine = create_engine(str(settings.SQLALCHEMY_DATABASE_URI))


# make sure all SQLModel models are imported (app.models) before initializing DB
# otherwise, SQLModel might fail to initialize relationships properly
# for more details: https://github.com/tiangolo/full-stack-fastapi-template/issues/28


# def init_db(session: Session) -> None:
#     # Tables should be created with Alembic migrations
#     # But if you don't want to use migrations, create
#     # the tables un-commenting the next lines
#     # from sqlmodel import SQLModel

#     # from app.core.engine import engine
#     # This works because the models are already imported and registered from app.models
#     # SQLModel.metadata.create_all(engine)
#     return
