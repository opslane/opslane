from app.services.alert import get_alert_configuration_stats
from app.core.config import settings
from app.schemas.alert import SeverityLevel
from typing import Dict, Any
import math


class AlertClassifier:
    def __init__(self):
        self.rules = [
            {
                "name": "severity",
                "condition": lambda alert: alert["severity"],
                "score": lambda severity: {
                    SeverityLevel.CRITICAL: 0.9,
                    SeverityLevel.HIGH: 0.7,
                    SeverityLevel.MEDIUM: 0.5,
                    SeverityLevel.LOW: 0.3,
                }.get(severity, 0),
                "weight": 0.3,
            },
            {
                "name": "unique_open_alerts",
                "condition": lambda alert: alert["unique_open_alerts"],
                "score": lambda count: 1 if count == 0 else 1 / (1 + math.log(count)),
                "weight": 0.2,
            },
            {
                "name": "average_resolution_time",
                "condition": lambda alert: alert["average_duration_seconds"],
                "score": lambda time: 1 / (1 + math.exp(-0.0001 * (time - 3600))),
                "weight": 0.15,
            },
            {
                "name": "is_noisy",
                "condition": lambda alert: alert["is_noisy"],
                "score": lambda is_noisy: 0.2 if is_noisy else 0.8,
                "weight": 0.25,
            },
            {
                "name": "occurrence_frequency",
                "condition": lambda alert: alert.get("unique_open_alerts", 0),
                "score": lambda freq: 1 / (1 + math.log(freq + 1)),
                "weight": 0.1,
            },
        ]
        self.threshold = settings.PREDICTION_CONFIDENCE_THRESHOLD

    def classify(self, alert: Dict[str, Any]) -> Dict[str, Any]:
        alert_stats = get_alert_configuration_stats(alert["alert_id"])
        alert_data = {**alert, **alert_stats}

        total_score = 0
        total_weight = 0

        for rule in self.rules:
            condition_value = rule["condition"](alert_data)
            if condition_value is not None:
                score = rule["score"](condition_value)
                weight = rule["weight"]
                total_score += score * weight
                total_weight += weight

        if total_weight == 0:
            confidence = 0
        else:
            confidence = total_score / total_weight

        is_actionable = confidence > self.threshold

        return {
            "is_actionable": is_actionable,
            "confidence": confidence,
            "factors": self._get_contributing_factors(alert_data),
        }

    def _get_contributing_factors(self, alert_data: Dict[str, Any]) -> Dict[str, Any]:
        factors = {}
        for rule in self.rules:
            condition_value = rule["condition"](alert_data)
            if condition_value is not None:
                score = rule["score"](condition_value)
                factors[rule["name"]] = {
                    "value": condition_value,
                    "score": score,
                    "weight": rule["weight"],
                }
        return factors


# Create a single instance of the classifier to be used throughout the application
alert_classifier = AlertClassifier()
