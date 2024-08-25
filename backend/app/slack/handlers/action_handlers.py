"""Action handlers for Slack interactive components."""

import json
import re

from app.services.alert import (
    get_alert_configuration,
    update_alert_feedback,
)
from app.integrations.providers.factory import IntegrationSourceFactory


def register_action_handlers(bot):
    """
    Register action handlers for Slack interactive components.

    Args:
        bot: The bot instance to register handlers for.
    """

    @bot.slack_app.action("thumbs_up")
    async def handle_thumbs_up(ack, body, say):
        """
        Handle the thumbs up action.

        Args:
            ack: Function to acknowledge the action.
            body: The request body from Slack.
            say: Function to send a message to the channel.
        """
        await ack()
        value = body["actions"][0]["value"]
        await handle_feedback(bot, body, say, is_positive=True, value=value)

    @bot.slack_app.action("thumbs_down")
    async def handle_thumbs_down(ack, body, say):
        """
        Handle the thumbs down action.

        Args:
            ack: Function to acknowledge the action.
            body: The request body from Slack.
            say: Function to send a message to the channel.
        """
        await ack()
        value = body["actions"][0]["value"]
        await handle_feedback(bot, body, say, is_positive=False, value=value)

    @bot.slack_app.action(re.compile("silence_alert_.*"))
    async def handle_silence_alert(ack, body, say):
        """
        Handle the silence alert action.

        Args:
            ack: Function to acknowledge the action.
            body: The request body from Slack.
            say: Function to send a message to the channel.
        """
        await ack()
        alert_id = body["actions"][0]["value"].split("_")[-1]
        user_id = body["user"]["id"]
        channel_id = body["container"]["channel_id"]

        success = await silence_alert(alert_id)

        if success:
            await bot.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Alert with ID {alert_id} has been silenced.",
            )
        else:
            await bot.slack_app.client.chat_postEphemeral(
                channel=channel_id,
                user=user_id,
                text=f"Failed to silence alert with ID {alert_id}. Please try again or contact support.",
            )


async def handle_feedback(bot, body, say, is_positive, value):
    """
    Handle user feedback on alert classification.

    Args:
        bot: The bot instance.
        body: The request body from Slack.
        say: Function to send a message to the channel.
        is_positive: Boolean indicating if the feedback is positive.
        classification: The original classification of the alert.
    """
    value_dict = json.loads(value)

    classification = value_dict["is_actionable"]
    alert_id = value_dict["alert_id"]
    alert_configuration_id = value_dict["alert_configuration_id"]

    is_noisy = (
        (classification is False and is_positive)
        or (classification is True and not is_positive)
        or False
    )

    # Update the alert in the database
    update_alert_feedback(
        alert_id=alert_id,
        alert_configuration_id=alert_configuration_id,
        is_noisy=is_noisy,
    )

    # Respond to the user
    response_text = (
        "Thank you for your feedback! We'll use this to improve our predictions."
    )

    await bot.slack_app.client.chat_postEphemeral(
        channel=body["channel"]["id"], user=body["user"]["id"], text=response_text
    )


async def silence_alert(alert_id: str) -> bool:
    """
    Silence an alert using the appropriate integration.

    Args:
        alert_id: The ID of the alert to silence.

    Returns:
        bool: True if the alert was successfully silenced, False otherwise.
    """
    alert_config = get_alert_configuration(alert_id)
    integration = IntegrationSourceFactory.get_integration(alert_config.provider)
    return await integration.silence_alert(alert_id)
