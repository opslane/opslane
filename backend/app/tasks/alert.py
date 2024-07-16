"""Alert background tasks"""

from app.core.config import settings
from app.integrations.providers.factory import IntegrationSourceFactory
from app.ml.services.prediction import AlertPredictor


async def _check_actionable(alert: dict) -> bool:
    """Check if the alert is actionable.

    Alert is actionable if the prediction is above the threshold.

    Args:
        alert (dict): The alert to check.

    Returns:
        bool: True if the alert is actionable, False otherwise.

    """
    predictor = AlertPredictor()
    prediction = await predictor.predict(alert)

    return prediction and float(prediction) > settings.PREDICTION_CONFIDENCE_THRESHOLD


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

    # 1. Normalize the alert
    integration = IntegrationSourceFactory.get_integration(source)
    processed_alert = integration.process_alert(raw_alert)

    # 2. Check if alert is actionable
    is_actionable = await _check_actionable(raw_alert)

    # 3. Send notifications
    if is_actionable:
        _send_notifications(processed_alert, notification_manager)
