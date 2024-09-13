"""Alert background tasks"""

from app.integrations.providers.factory import IntegrationSourceFactory


async def process_alert(source: str, raw_alert: dict) -> None:
    """Process the alert asynchronously.

    This function performs the following steps:
    1. Normalizes the alert using the appropriate integration.
    2. Checks if the alert is actionable.
    3. Sends notifications if the alert is deemed actionable.

    Args:
        source (str): The source of the alert.
        raw_alert (dict): The raw alert data.
        notification_manager (NotificationManager): The notification manager instance.

    Returns:
        None
    """
    try:
        integration = IntegrationSourceFactory.get_integration(source)
        processed_alert = integration.process_alert(raw_alert)
    except ValueError as exc:
        raise ValueError(f"Invalid alert source: {source}") from exc
