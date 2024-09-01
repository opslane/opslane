"""Script to initialize and seed the database with initial data."""

import os
import logging

from alembic import command
from alembic.config import Config
from sqlmodel import Session, select

from app.core.config import settings
from app.db.base import engine
from app.db.models.tenant import Tenant
from app.schemas.tenant import TenantCreate
from app.services.tenant import create_tenant

# Import all models to ensure they're registered with SQLModel
from app.db.models import *  # noqa

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def run_migrations():
    """Run database migrations using Alembic."""
    logger.info("Running database migrations...")
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    logger.info("Database migrations completed.")


def create_initial_tenant():
    """Create initial tenant if it doesn't exist."""

    tenant_name = settings.TENANT_NAME
    with Session(engine) as session:
        existing_tenant = session.exec(
            select(Tenant).where(Tenant.name == tenant_name)
        ).first()

        if existing_tenant:
            logger.info("Tenant '%s' already exists.", tenant_name)
        else:
            logger.info("Creating initial tenant: %s", tenant_name)
            new_tenant = TenantCreate(name=tenant_name)
            created_tenant = create_tenant(session, new_tenant)
            logger.info(
                "Created tenant: ID=%s, Name=%s", created_tenant.id, created_tenant.name
            )


def seed_database():
    """Run migrations and create initial tenant."""

    run_migrations()
    create_initial_tenant()


if __name__ == "__main__":
    seed_database()
