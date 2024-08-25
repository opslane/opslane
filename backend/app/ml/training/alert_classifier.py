import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
import joblib
from datetime import datetime, timedelta
from app.schemas.alert import SeverityLevel


def generate_synthetic_data(num_samples=1000):
    np.random.seed(42)
    data = []
    for _ in range(num_samples):
        severity = np.random.choice(
            [
                SeverityLevel.CRITICAL,
                SeverityLevel.HIGH,
                SeverityLevel.MEDIUM,
                SeverityLevel.LOW,
            ]
        )
        unique_open_alerts = np.random.randint(0, 20)
        avg_resolution_time = np.random.randint(0, 7200)
        is_noisy = np.random.choice([True, False])
        created_at = datetime.now() - timedelta(days=np.random.randint(0, 30))
        name = f"Alert {'error' if np.random.random() < 0.3 else ''} {'critical' if np.random.random() < 0.2 else ''} {np.random.randint(1000, 9999)}"

        features = {
            "severity_score": map_severity(severity),
            "unique_open_alerts": unique_open_alerts,
            "avg_resolution_time": avg_resolution_time,
            "is_noisy": int(is_noisy),
            "occurrence_frequency": unique_open_alerts,
            "time_of_day": created_at.hour,
            "day_of_week": created_at.weekday(),
            "alert_title_length": len(name),
            "has_error_keyword": int("error" in name.lower()),
            "has_critical_keyword": int("critical" in name.lower()),
        }

        # Determine if actionable based on some rules
        is_actionable = (
            features["severity_score"] > 2
            or features["unique_open_alerts"] < 5
            or (not is_noisy and avg_resolution_time > 3600)
        )

        features["is_actionable"] = int(is_actionable)
        data.append(features)

    return pd.DataFrame(data)


def map_severity(severity):
    severity_map = {
        SeverityLevel.CRITICAL: 4,
        SeverityLevel.HIGH: 3,
        SeverityLevel.MEDIUM: 2,
        SeverityLevel.LOW: 1,
    }
    return severity_map.get(severity, 0)


def train_model():
    data = generate_synthetic_data()
    X = data.drop("is_actionable", axis=1)
    y = data["is_actionable"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    precision = precision_score(y_test, y_pred)
    recall = recall_score(y_test, y_pred)
    f1 = f1_score(y_test, y_pred)

    print(f"Accuracy: {accuracy}")
    print(f"Precision: {precision}")
    print(f"Recall: {recall}")
    print(f"F1 Score: {f1}")

    joblib.dump(model, "alert_classifier_model.joblib")

    return model


if __name__ == "__main__":
    trained_model = train_model()
