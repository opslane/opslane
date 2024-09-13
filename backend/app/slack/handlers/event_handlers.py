"""Event handlers for Slack events."""

from typing import Any, Dict

# from app.agents.alert_classifier import alert_classifier_rag
# from app.agents.conversational import ConversationAgent
# from app.ml.alert_classifier import alert_classifier

from app.agents.rca import rca_agent
from app.agents.pagerduty import pagerduty_agent
from app.tools.confluence import fetch_relevant_documents
from app.tools.datadog import fetch_datadog_logs
from app.tools.github import get_latest_git_changes

# from app.schemas.alert import SeverityLevel
from app.slack.reports import (
    # format_prediction_blocks,
    create_rca_blocks,
    create_confluence_blocks,
)


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

        if thread_ts and "text" in event and f"<@{bot.bot_user_id}>" in event["text"]:
            # conversation_agent = ConversationAgent(rca_agent)
            # user_message = event["text"].replace(f"<@{bot.bot_user_id}>", "").strip()
            # response = conversation_agent.run(user_message)
            # await say(
            #     text=response,
            #     channel=channel_id,
            #     thread_ts=thread_ts,
            # )

            return

        if "bot_id" in event:
            if event["bot_id"] == bot.bot_user_id:
                return

            if event["bot_id"] in bot.allowed_bot_ids and "metadata" in event:
                event_payload = event["metadata"]["event_payload"]
                incident_id = event_payload["incident"]["id"]
                status = event_payload["incident"]["status"]
                if status == "triggered":
                    # Send initial message
                    initial_message = await say(
                        text="Processing the alert. I'll update with the Root Cause Analysis results soon.",
                        channel=channel_id,
                        thread_ts=thread_ts,
                    )

                    # Process the alert
                    pd_result = pagerduty_agent.run(incident_id=incident_id)

                    # fetch confluence kb articles
                    document = fetch_relevant_documents(pd_result.alert_summary)
                    confluence_blocks = create_confluence_blocks(document)
                    await say(
                        blocks=confluence_blocks,
                        text="Confluence",  # Fallback text for notifications
                        channel=channel_id,
                        thread_ts=thread_ts,
                    )

                    # fetch the logs from datadog
                    logs = fetch_datadog_logs(pd_result.query)

                    # fetch the git changes
                    git_changes = get_latest_git_changes(
                        repo_name="abhishekray07/stock-trader"
                    )

                    # Run the RCA agent
                    rca_result = rca_agent.run(
                        alert_description=pd_result.alert_summary,
                        log_lines=logs,
                        code_changes=git_changes,
                    )

                    blocks = create_rca_blocks(rca_result)

                    # Update with RCA results
                    await say(
                        blocks=blocks,
                        text="Root Cause Analysis Results",  # Fallback text for notifications
                        channel=channel_id,
                        thread_ts=thread_ts,
                    )

        #         alert_id = event["metadata"]["event_payload"]["event_id"]
        #         alert_configuration_id = event["metadata"]["event_payload"][
        #             "monitor_id"
        #         ]
        #         alert_title = event["attachments"][0].get("title", "")
        #         alert_description = event["attachments"][0].get("text", "")

        #         # Prepare the alert data for classification
        #         alert_data = {
        #             "alert_id": alert_id,
        #             "alert_configuration_id": alert_configuration_id,
        #             "title": alert_title,
        #             "description": alert_description,
        #             "severity": SeverityLevel.MEDIUM,  # You might want to extract this from the event
        #             "created_at": datetime.now(),  # Use the actual timestamp from the event if available
        #         }

        #         # Get alert classification
        #         classification_result = alert_classifier.classify(alert_data)

        #         # Use the classification result in the RAG model
        #         alert_summary = {
        #             "summary": alert_classifier_rag.run(query=classification_result),
        #             "is_actionable": classification_result["is_actionable"],
        #         }

        #         blocks = format_prediction_blocks(alert_summary, alert_data)
        #         await say(blocks=blocks, channel=channel_id, thread_ts=thread_ts)
