"""Alert background tasks"""

from app.integrations.providers.factory import IntegrationSourceFactory
from app.managers.notification_manager import NotificationManager
from app.ml.services.prediction import AlertPredictor


async def _check_actionable(alert: dict) -> bool:
    """Check if the alert is actionable."""
    predictor = AlertPredictor()
    prediction = await predictor.predict(alert)

    return prediction and float(prediction) > 0.5


def _send_notifications(alert: dict, notification_manager: NotificationManager):
    """Send notifications for the alert."""
    notification_manager.send_notification(alert)


async def process_alert(
    source: str, raw_alert: dict, notification_manager: NotificationManager
) -> None:
    """Process the alert."""

    # 1. Normalize the alert
    integration = IntegrationSourceFactory.get_integration(source)
    processed_alert = integration.process_alert(raw_alert)

    # 2. Check if alert is actionable
    is_actionable = await _check_actionable(raw_alert)

    # 3. Send notifications
    if is_actionable:
        print("Alert is actionable")
        _send_notifications(processed_alert, notification_manager)
    else:
        print("Alert is not actionable.")
