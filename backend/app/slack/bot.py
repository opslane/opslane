"""Main SlackBot class for handling Slack events and actions."""

import asyncio

from typing import Set
from slack_bolt.async_app import AsyncApp
from slack_bolt.adapter.fastapi.async_handler import AsyncSlackRequestHandler

from app.core.config import settings
from app.slack.handlers.event_handlers import register_event_handlers
from app.slack.handlers.command_handlers import register_command_handlers
from app.slack.handlers.action_handlers import register_action_handlers
from app.slack.utils import get_allowed_bot_ids
from app.ml.alert_classifier import AlertClassifier
from app.ml.utils import get_alert_by_id
from app.slack.reports import build_explanation_blocks


class SlackBot:
    """
    Main SlackBot class for handling Slack events and actions.
    """

    def __init__(self):
        """
        Initialize the SlackBot with necessary components and configurations.
        """
        self.slack_app: AsyncApp = AsyncApp(
            token=settings.SLACK_BOT_TOKEN, signing_secret=settings.SLACK_SIGNING_SECRET
        )
        self.slack_handler: AsyncSlackRequestHandler = AsyncSlackRequestHandler(
            self.slack_app
        )
        self.bot_user_id: str | None = None
        self.allowed_bot_ids: list[str] = []

        asyncio.create_task(self._initialize())
        self._register_handlers()

    async def _initialize(self) -> None:
        """
        Initialize bot user ID and allowed bot IDs asynchronously.
        """
        await self._initialize_bot_user_id()
        await self._initialize_allowed_bot_ids()

    async def _initialize_bot_user_id(self) -> None:
        """
        Fetch and set the bot user ID from Slack API.
        """
        try:
            auth_response = await self.slack_app.client.auth_test()
            self.bot_user_id = auth_response["user_id"]
        except Exception as e:
            print(f"Error fetching bot user ID: {e}")

    async def _initialize_allowed_bot_ids(self) -> None:
        """
        Fetch and set the list of allowed bot IDs.
        """
        self.allowed_bot_ids = await get_allowed_bot_ids(self.slack_app)

    def _register_handlers(self) -> None:
        """
        Register event, command, and action handlers for the SlackBot.
        """
        register_event_handlers(self)
        register_command_handlers(self)
        register_action_handlers(self)
        self.slack_app.action("explain_alert")(self.handle_alert_explanation_request)

    async def handle_alert_explanation_request(
        self,
        client,
        body,
        alert_id: str,
        classifier: AlertClassifier
    ):
        """Handle requests for alert classification explanations."""
        try:
            # Get alert details
            alert = await get_alert_by_id(alert_id)
            if not alert:
                await client.chat_postMessage(
                    channel=body["channel_id"],
                    text="❌ Alert not found"
                )
                return

            # Get classification with explanation
            result = classifier.classify(alert)
            
            # Build explanation message
            blocks = build_explanation_blocks(alert, result)
            
            await client.chat_postMessage(
                channel=body["channel_id"],
                blocks=blocks
            )
        except Exception as e:
            logger.error(f"Error handling explanation request: {e}")
            await client.chat_postMessage(
                channel=body["channel_id"],
                text="❌ Error generating explanation"
            )


slack_bot: SlackBot = SlackBot()
slack_handler: AsyncSlackRequestHandler = slack_bot.slack_handler
