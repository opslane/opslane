"""Event handlers for Slack events."""

from datetime import datetime
from typing import Any, Dict


from app.slack.reports import format_prediction_blocks
from app.ml.alert_classifier import alert_classifier
from app.agents.alert_classifier import alert_classifier_rag
from app.schemas.alert import SeverityLevel


def register_event_handlers(bot) -> None:
    """
    Register event handlers for Slack events.

    Args:
        bot (SlackBot): The Slack bot instance.
    """

    @bot.slack_app.event("member_joined_channel")
    async def handle_member_joined(event: Dict[str, Any], say: Any) -> None:
        """
        Handle the 'member_joined_channel' event.

        Args:
            event (Dict[str, Any]): The event data.
            say (Any): The say function for sending messages.
        """
        if event.get("user") == bot.bot_user_id:
            channel_id = event.get("channel")
            if channel_id:
                bot.alert_channels.add(channel_id)
                bot.save_alert_channels()
                await bot.ingest_historical_data(channel_id)

    @bot.slack_app.event("message")
    async def handle_message_events(event: Dict[str, Any], say: Any) -> None:
        """
        Handle the 'message' event.

        Args:
            event (Dict[str, Any]): The event data.
            say (Any): The say function for sending messages.
        """
        channel_id = event["channel"]
        thread_ts = event["ts"]

        if "bot_id" in event:
            if event["bot_id"] == bot.bot_user_id:
                return

            if event["bot_id"] in bot.allowed_bot_ids:
                alert_id = event["metadata"]["event_payload"]["monitor_id"]
                alert_title = event["attachments"][0].get("title", "")
                alert_description = event["attachments"][0].get("text", "")

                # Prepare the alert data for classification
                alert_data = {
                    "alert_id": alert_id,
                    "title": alert_title,
                    "description": alert_description,
                    "severity": SeverityLevel.MEDIUM,  # You might want to extract this from the event
                    "created_at": datetime.now(),  # Use the actual timestamp from the event if available
                }

                # Get alert classification
                classification_result = alert_classifier.classify(alert_data)

                # Use the classification result in the RAG model
                alert_summary = alert_classifier_rag.run(query=classification_result)

                blocks = format_prediction_blocks(alert_summary)
                await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
        # else:
        #     result = "Test"
        #     blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": result}}]
        #     await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
