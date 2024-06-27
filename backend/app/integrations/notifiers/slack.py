"""Slack notifier module."""

import slack_sdk
from sqlmodel import Session

from app.db import engine

from app.core.config import settings
from app.db.models.alert import Alert
from .base import BaseNotifier


class SlackNotifier(BaseNotifier):
    """Integration for Slack."""

    def __init__(self):
        self.client = slack_sdk.WebClient(token=settings.SLACK_BOT_TOKEN)
        self.username = "Opslane Bot"
        self.icon_emoji = ":robot_face:"
        self.timestamp = ""

    def notify(self, alert: Alert):
        """Send notification to Slack."""

        with Session(engine) as session:
            session.add(alert)
            session.refresh(alert)

            blocks = [
                {
                    "type": "header",
                    "text": {
                        "type": "plain_text",
                        "text": "Alert Notification",
                        "emoji": True,
                    },
                },
                {
                    "type": "section",
                    "fields": [
                        {"type": "mrkdwn", "text": f"*Title:*\n{alert.title}"},
                        {
                            "type": "mrkdwn",
                            "text": f"*Description:*\n{alert.description}",
                        },
                        {"type": "mrkdwn", "text": f"*Severity:*\n{alert.severity}"},
                        {"type": "mrkdwn", "text": f"*Status:*\n{alert.status}"},
                        {"type": "mrkdwn", "text": f"*Source:*\n{alert.alert_source}"},
                        {
                            "type": "mrkdwn",
                            "text": f"*Created At:*\n{alert.created_at}",
                        },
                        {
                            "type": "mrkdwn",
                            "text": f"*Updated At:*\n{alert.updated_at}",
                        },
                    ],
                },
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Tags:*\n{', '.join(alert.tags)}",
                    },
                },
            ]

            self.client.chat_postMessage(
                ts=self.timestamp,
                channel="#test-alerts",
                username=self.username,
                icon_emoji=self.icon_emoji,
                blocks=blocks,
            )
