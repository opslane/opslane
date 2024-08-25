"""Module for training the alert classifier model."""

import click
import pandas as pd
import joblib
from typing import List, Dict, Any

from sqlmodel import select, Session, update
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score

from app.services.alert import (
    pull_and_store_alerts_from_source,
    get_alert_configuration_stats,
)
from app.schemas.alert import AlertSource
from app.db.models.alert import Alert
from app.db import engine
from app.ml.utils import engineer_features


def get_recent_alerts() -> List[Dict[str, Any]]:
    """
    Retrieve recent alerts from the database.

    Returns:
        List[Dict[str, Any]]: A list of dictionaries containing alert data.
    """
    with Session(engine) as session:
        alerts = session.exec(
            select(Alert).order_by(Alert.created_at.desc()).limit(100)
        ).all()
        return [alert.dict() for alert in alerts]


@click.command()
@click.option("--num-alerts", default=20, help="Number of alerts to label")
def train_model_cli(num_alerts: int):
    """
    CLI command to train the alert classifier model.

    Args:
        num_alerts (int): Number of alerts to use for training.
    """
    click.echo("Pulling recent alerts from Datadog...")
    pull_and_store_alerts_from_source(AlertSource.DATADOG)

    alerts = get_recent_alerts()[:num_alerts]
    labeled_data = []

    with Session(engine) as session:
        for alert in alerts:
            click.echo(f"\nAlert: {alert['title']}")
            click.echo(f"Severity: {alert['severity']}")
            click.echo(f"Description: {alert['description']}")

            is_actionable = click.confirm("Is this alert actionable?", default=True)
            is_noisy = not is_actionable

            # Update the alert in the database
            stmt = (
                update(Alert).where(Alert.id == alert["id"]).values(is_noisy=is_noisy)
            )
            session.exec(stmt)

            alert_stats = get_alert_configuration_stats(alert["configuration_id"])
            features = engineer_features(alert, alert_stats)
            features["is_actionable"] = int(is_actionable)
            labeled_data.append(features)

        session.commit()

    df = pd.DataFrame(labeled_data)
    X = df.drop("is_actionable", axis=1)
    y = df["is_actionable"]

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

    click.echo("\nModel Performance:")
    click.echo(f"Accuracy: {accuracy}")
    click.echo(f"Precision: {precision}")
    click.echo(f"Recall: {recall}")
    click.echo(f"F1 Score: {f1}")

    joblib.dump(model, "alert_classifier_model.joblib")
    click.echo("\nModel saved as 'alert_classifier_model.joblib'")


if __name__ == "__main__":
    train_model_cli()
