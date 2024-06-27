"""Alert background tasks"""

from app.integrations.factory import IntegrationSourceFactory


def _check_actionable(alert: dict) -> bool:
    """Check if the alert is actionable."""
    return True


def _send_notifications(alert: dict):
    """Send notifications for the alert."""
    return True


def process_alert(source: str, raw_alert: dict):
    """Process the alert."""

    # 1. Normalize the alert
    integration = IntegrationSourceFactory.get_integration(source)
    processed_alert = integration.process_alert(raw_alert)

    # 2. Check if alert is actionable
    is_actionable = _check_actionable(processed_alert)

    # 3. Send notifications
    if is_actionable:
        _send_notifications(processed_alert)
    else:
        print("Alert is not actionable.")
