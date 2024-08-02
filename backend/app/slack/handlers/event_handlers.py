"""Event handlers for Slack events."""

from app.ml.chat import answer_question
from app.services.alert import get_alert_configuration_stats
from app.core.config import settings
from app.slack.utils import is_alert_message, process_historical_alert
from app.slack.reports import format_prediction_blocks


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
                prediction = bot.classifier_agent.run(query=query)

                # Get alert root cause
                debug_query = {**query, "classification": prediction}
                root_cause = bot.debug_agent.run(query=debug_query)
                print(root_cause)

                blocks = format_prediction_blocks(
                    prediction, settings.PREDICTION_CONFIDENCE_THRESHOLD
                )
                await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
        else:
            result = await answer_question(event["text"])
            blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": result}}]
            await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)

    bot.ingest_historical_data = ingest_historical_data


async def ingest_historical_data(bot, channel_id: str, days_back: int = 30):
    # Implementation of ingest_historical_data
    pass
