"""Module for classifying alerts using a trained machine learning model."""

import os
from typing import Dict, Any, Optional

import joblib

from app.services.alert import get_alert_configuration_stats
from app.core.config import settings
from app.ml.utils import engineer_features


class AlertClassifier:
    def __init__(self):
        """Initialize the AlertClassifier with a trained model and confidence threshold."""
        self.model: Optional[Any] = None
        self.threshold = settings.PREDICTION_CONFIDENCE_THRESHOLD
        self.model_path = "alert_classifier_model.joblib"
        self.last_loaded_time = 0
        self._load_model()

    def _load_model(self):
        """Attempt to load the trained model if it exists or has been updated."""
        if os.path.exists(self.model_path):
            current_mtime = os.path.getmtime(self.model_path)
            if current_mtime > self.last_loaded_time:
                try:
                    self.model = joblib.load(self.model_path)
                    self.last_loaded_time = current_mtime
                    print(f"Model loaded successfully from {self.model_path}")
                except Exception as e:
                    print(f"Error loading model: {e}")
                    self.model = None
            else:
                print("Model is up to date")
        else:
            print(f"Model file not found: {self.model_path}")
            self.model = None

    def classify(self, alert: Dict[str, Any]) -> Dict[str, Any]:
        """
        Classify an alert as actionable or not.

        Args:
            alert (Dict[str, Any]): The alert data to classify.

        Returns:
            Dict[str, Any]: Classification result including actionability, confidence, and contributing factors.
        """
        self._load_model()  # Check and load the model if necessary

        if self.model is None:
            return {
                "error": "Model not available",
                "is_actionable": "unknown",
                "confidence": 0.0,
                "factors": {},
            }

        alert_stats = get_alert_configuration_stats(alert["alert_id"])
        features = engineer_features(alert, alert_stats)

        # Use the model to predict
        feature_values = [features[feature] for feature in self.model.feature_names_in_]
        prediction = self.model.predict_proba([feature_values])[0]

        if len(prediction) < 2:
            print(f"Unexpected prediction format: {prediction}")
            return {
                "error": "Unexpected prediction format",
                "is_actionable": "unknown",
                "confidence": 0.0,
                "factors": {},
            }

        confidence = prediction[1]  # Probability of being actionable
        is_actionable = confidence > self.threshold

        return {
            "is_actionable": str(is_actionable),
            "confidence": float(confidence),
            "factors": self._get_contributing_factors(features),
        }

    def _get_contributing_factors(self, features: Dict[str, Any]) -> Dict[str, Any]:
        """
        Determine the contributing factors for the classification.

        Args:
            features (Dict[str, Any]): The engineered features used for classification.

        Returns:
            Dict[str, Any]: The contributing factors (currently just returns the features).
        """
        # You can implement logic here to determine contributing factors
        # For now, we'll just return the features
        return features


# Create a single instance of the classifier to be used throughout the application
alert_classifier = AlertClassifier()
