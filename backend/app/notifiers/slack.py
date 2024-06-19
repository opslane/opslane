"""Slack notifier module."""

import slack_sdk

from app.core.config import settings
from .base import BaseNotifier


class SlackNotifier(BaseNotifier):
    """Integration for Slack."""

    def __init__(self):
        self.client = slack_sdk.WebClient(token=settings.SLACK_BOT_TOKEN)
        self.username = "pythonboardingbot"
        self.icon_emoji = ":robot_face:"
        self.timestamp = ""
        self.blocks = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        "Welcome to Slack! :wave: We're so glad you're here. :blush:\n\n"
                        "*Get started by completing the steps below:*"
                    ),
                },
            }
        ]

    def notify(self, message: str):
        """Send notification to Slack."""
        print("Processing Slack message:", message)
        self.client.chat_postMessage(
            ts=self.timestamp,
            channel="#test-alerts",
            username=self.username,
            icon_emoji=self.icon_emoji,
            blocks=self.blocks,
        )
