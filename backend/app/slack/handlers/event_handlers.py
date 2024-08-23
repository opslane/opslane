"""Event handlers for Slack events."""

from app.core.config import settings
from app.slack.reports import format_prediction_blocks
from app.ml.alert_classifier import alert_classifier
from app.agents.alert_classifier import alert_classifier_rag


def register_event_handlers(bot):
    @bot.slack_app.event("member_joined_channel")
    async def handle_member_joined(event, say):
        if event.get("user") == bot.bot_user_id:
            channel_id = event.get("channel")
            if channel_id:
                bot.alert_channels.add(channel_id)
                bot.save_alert_channels()
                await bot.ingest_historical_data(channel_id)

    @bot.slack_app.event("message")
    async def handle_message_events(event, say):

        channel_id = event["channel"]
        thread_ts = event["ts"]

        if "bot_id" in event:
            if event["bot_id"] == bot.bot_user_id:
                return

            if event["bot_id"] in bot.allowed_bot_ids:
                alert_id = event["metadata"]["event_payload"]["monitor_id"]
                query = {
                    "alert_id": alert_id,
                    "alert_title": event["attachments"][0].get("title", ""),
                    "alert_description": event["attachments"][0].get("text", ""),
                }

                # Get alert classification
                result = alert_classifier.classify(query)
                prediction = alert_classifier_rag.run(query=result)

                blocks = format_prediction_blocks(prediction)
                await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
        else:
            result = "Test"
            blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": result}}]
            await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
