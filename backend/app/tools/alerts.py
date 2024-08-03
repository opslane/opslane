"""Agent tools related to alerts."""

from app.services.alert import get_alert_configuration_stats


def fetch_alert_stats(alert_id: str) -> dict:
    """Get statistics for the current alert."""
    return get_alert_configuration_stats(alert_id)


def debug_noisy_alert(alert_id: str) -> dict:
    """Debug a noisy alert."""
    return {
        "alert_id": alert_id,
        "owner": "Abhishek Ray",
        "created": "2021-10-01",
        "reason": "Noisy alert due to volatile metric",
        "metric_name": "CPU Usage",
        "threshold": "80%",
        "current_value": "85%",
        "historical_pattern": "Fluctuates between 75% and 85% frequently",
        "suggested_action": "Consider adjusting the threshold or implementing a moving average",
    }
