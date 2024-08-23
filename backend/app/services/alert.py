"""Alert related services methods"""

from datetime import datetime, timedelta
from typing import Any, Dict, Tuple, Optional

from sqlmodel import select, func, Session

from app.db import engine
from app.db.models.alert import Alert, AlertConfiguration, AlertSource, AlertStatus

from app.schemas.alert import AlertConfigurationSchema, AlertSchema


def _convert_alert_configuration_schema_to_db_model(
    config_schema: AlertConfigurationSchema,
) -> AlertConfiguration:
    """Convert AlertConfigurationSchema to AlertConfiguration model."""
    return AlertConfiguration(
        name=config_schema.name,
        description=config_schema.description,
        query=config_schema.query,
        provider=config_schema.provider,
        provider_id=config_schema.provider_id,
        is_noisy=config_schema.is_noisy,
    )


def _convert_alert_schema_to_db_model(alert_schema: AlertSchema) -> Alert:
    """Convert AlertSchema to Alert model."""
    return Alert(
        title=alert_schema.title,
        description=alert_schema.description,
        severity=alert_schema.severity,
        status=alert_schema.status,
        alert_source=alert_schema.alert_source,
        tags=alert_schema.tags,
        service=alert_schema.service,
        env=alert_schema.env,
        additional_data=alert_schema.dict(),
        provider_event_id=alert_schema.provider_event_id,
        provider_cycle_key=alert_schema.provider_cycle_key,
        configuration_id=alert_schema.configuration_id,
        provider_aggregation_key=alert_schema.provider_aggregation_key,
        duration_seconds=alert_schema.duration_seconds,
    )


def store_alert_configuration_in_db(
    config: AlertConfigurationSchema,
) -> AlertConfiguration:
    """Store alert configuration in the database."""
    with Session(engine) as session:
        config_db = _convert_alert_configuration_schema_to_db_model(config)
        session.add(config_db)
        session.commit()
        session.refresh(config_db)
        return config_db


def get_or_create_alert_configuration(
    config_schema: AlertConfigurationSchema,
) -> AlertConfiguration:
    """Get or create alert configuration in the database."""
    with Session(engine) as session:
        statement = select(AlertConfiguration).where(
            AlertConfiguration.provider_id == config_schema.provider_id
        )
        result = session.execute(statement)
        existing_config = result.scalar_one_or_none()

        if existing_config:
            return existing_config.id

        # Create a new configuration if it doesn't exist
        new_config = _convert_alert_configuration_schema_to_db_model(config_schema)
        session.add(new_config)
        session.commit()
        session.refresh(new_config)

        return new_config.id


def get_alert_configuration(provider_id: str) -> Optional[AlertConfiguration]:
    """Get alert configuration by provider_id."""
    with Session(engine) as session:
        statement = select(AlertConfiguration).where(
            AlertConfiguration.provider_id == provider_id
        )
        return session.exec(statement).first()


def store_alert_in_db(alert: AlertSchema) -> Alert:
    """Store alert in the database."""
    with Session(engine) as session:
        alert_db = _convert_alert_schema_to_db_model(alert)

        # Get the corresponding AlertConfiguration
        config = get_alert_configuration(alert.configuration_id)
        if config:
            alert_db.configuration = config
            alert_db.configuration_id = config.id
        else:
            print(
                f"Warning: No configuration found for provider_id {alert.configuration_id}"
            )

        session.add(alert_db)
        session.commit()
        session.refresh(alert_db)
        return alert_db


def pull_and_store_alerts_from_source(alert_source: AlertSource) -> Tuple[int, int]:
    """
    Pull alert configurations and alerts from the specified source and store them in the database.

    Args:
        alert_source (AlertSource): The source to pull alerts from.

    Returns:
        Tuple[int, int]: A tuple containing the number of configurations and alerts stored.
    """

    from app.integrations.providers.factory import IntegrationSourceFactory

    try:
        integration = IntegrationSourceFactory.get_integration(alert_source.value)
    except ValueError as e:
        raise ValueError(
            f"Failed to load integration for source {alert_source}: {str(e)}"
        )

    alerts, configurations = integration.get_alerts()

    stored_configs = 0
    for config in configurations:
        get_or_create_alert_configuration(config)
        stored_configs += 1

    stored_alerts = 0
    for alert in alerts:
        store_alert_in_db(alert)
        stored_alerts += 1

    return stored_configs, stored_alerts


def get_alert_report_data(days: int = 7):
    """
    Retrieve alert report data from the database for the specified number of days.

    Args:
        days (int): Number of days to look back for the report. Defaults to 7.

    Returns:
        dict: A dictionary containing the report data.
    """
    end_date = datetime.utcnow()
    start_date = end_date - timedelta(days=days)

    with Session(engine) as session:
        # Get open alerts for the last 7 days
        open_alerts = session.exec(
            select(Alert).where(
                Alert.created_at.between(start_date, end_date),
                Alert.status == AlertStatus.OPEN,
            )
        ).all()

        # Top 5 most frequent alerts
        alert_counts = session.exec(
            select(Alert.title, func.count(Alert.id).label("count"))
            .where(Alert.created_at.between(start_date, end_date))
            .group_by(Alert.title)
            .order_by(func.count(Alert.id).desc())
            .limit(5)
        ).all()

        # Noisiest services
        noisy_services = session.exec(
            select(Alert.service, func.count(Alert.id).label("count"))
            .join(AlertConfiguration)
            .where(
                Alert.created_at.between(start_date, end_date),
                AlertConfiguration.is_noisy == True,
            )
            .group_by(Alert.service)
            .order_by(func.count(Alert.id).desc())
            .limit(5)
        ).all()

        # Daily alert volume
        daily_volume = session.exec(
            select(
                func.date(Alert.created_at).label("date"),
                func.count(Alert.id).label("count"),
            )
            .where(Alert.created_at.between(start_date, end_date))
            .group_by(func.date(Alert.created_at))
            .order_by("date")
        ).all()

        # Count of noisy alerts
        noisy_alerts_count = session.exec(
            select(func.count(Alert.id))
            .join(AlertConfiguration)
            .where(
                Alert.created_at.between(start_date, end_date),
                Alert.status == AlertStatus.OPEN,
                AlertConfiguration.is_noisy == True,
            )
        ).one()

        noisy_alerts = session.exec(
            select(AlertConfiguration)
            .where(AlertConfiguration.is_noisy == True)
            .order_by(AlertConfiguration.name)
        ).all()

    open_alerts = [AlertSchema.model_validate(alert) for alert in open_alerts]
    noisy_alerts = [
        AlertConfigurationSchema.model_validate(alert.model_dump())
        for alert in noisy_alerts
    ]

    return {
        "open_alerts": open_alerts,
        "top_alerts": alert_counts,
        "noisy_services": noisy_services,
        "daily_volume": [
            (date.strftime("%Y-%m-%d"), count) for date, count in daily_volume
        ],
        "start_date": start_date,
        "end_date": end_date,
        "noisy_alerts_count": noisy_alerts_count,
        "noisy_alerts": noisy_alerts,
    }


def calculate_alert_duration(
    alert_cycle_key: str, resolved_at: datetime
) -> Optional[int]:
    """Calculate the duration of an alert in seconds."""
    with Session(engine) as session:
        triggered_alert = session.exec(
            select(Alert)
            .where(Alert.provider_cycle_key == alert_cycle_key)
            .where(Alert.status == AlertStatus.OPEN.value)
            .order_by(Alert.created_at.desc())
        ).first()

        if triggered_alert and triggered_alert.created_at:
            triggered_at = triggered_alert.created_at
            return int((resolved_at - triggered_at).total_seconds())

    return None


def get_alert_configuration_stats(monitor_id: int) -> Dict[str, Any]:
    """Get statistics for an alert configuration"""
    with Session(engine) as session:
        # Get the alert configuration
        alert_config = session.exec(
            select(AlertConfiguration).where(
                AlertConfiguration.provider_id == str(monitor_id)
            )
        ).first()

        if not alert_config:
            return {"error": "Alert configuration not found"}

        # Get count of unique open alerts for this configuration
        unique_open_alerts = session.exec(
            select(func.count(Alert.id.distinct())).where(
                Alert.configuration_id == str(alert_config.provider_id),
                Alert.status == AlertStatus.OPEN,
            )
        ).one()

        # Get the average alert duration
        avg_duration = session.exec(
            select(func.avg(Alert.duration_seconds)).where(
                Alert.configuration_id == str(alert_config.provider_id),
                Alert.duration_seconds.isnot(None),
            )
        ).one()

        severity = session.exec(
            select(Alert.severity, func.count(Alert.id).label("count"))
            .where(Alert.configuration_id == str(alert_config.provider_id))
            .group_by(Alert.severity)
            .order_by(func.count(Alert.id).desc())
        ).first()

        return {
            "configuration_id": alert_config.id,
            "is_noisy": alert_config.is_noisy,
            "noisy_reason": alert_config.noisy_reason or "No reason provided",
            "provider_id": alert_config.provider_id,
            "name": alert_config.name,
            "unique_open_alerts": unique_open_alerts,
            "average_duration_seconds": avg_duration or 0,
            "severity": severity.severity,
        }


def mark_alert_configuration_as_noisy(
    provider_id: str, is_noisy: bool, reason: Optional[str] = None
) -> Optional[AlertConfiguration]:
    """
    Mark an AlertConfiguration as noisy or not noisy and provide a reason.

    Args:
        provider_id (str): The provider_id of the AlertConfiguration.
        is_noisy (bool): Whether to mark the configuration as noisy or not.
        reason (Optional[str]): The reason for marking the configuration as noisy or not.

    Returns:
        Optional[AlertConfiguration]: The updated AlertConfiguration if found, None otherwise.
    """
    with Session(engine) as session:
        statement = select(AlertConfiguration).where(
            AlertConfiguration.provider_id == provider_id
        )
        result = session.exec(statement)
        alert_config = result.first()

        if alert_config:
            alert_config.is_noisy = is_noisy
            alert_config.noisy_reason = reason if is_noisy else None
            session.add(alert_config)
            session.commit()
            session.refresh(alert_config)
            return alert_config
        else:
            print(f"Warning: No configuration found for provider_id {provider_id}")
            return None
