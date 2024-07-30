"""Action handlers for Slack interactive components."""

import re
from app.services.alert import (
    mark_alert_configuration_as_noisy,
    get_alert_configuration,
)
from app.integrations.providers.factory import IntegrationSourceFactory


def register_action_handlers(bot):
    @bot.slack_app.action("thumbs_up")
    async def handle_thumbs_up(ack, body, say):
        await ack()
        classification = body["actions"][0]["value"]
        await handle_feedback(
            bot, body, say, is_positive=True, classification=classification
        )

    @bot.slack_app.action("thumbs_down")
    async def handle_thumbs_down(ack, body, say):
        await ack()
        classification = body["actions"][0]["value"]
        await handle_feedback(
            bot, body, say, is_positive=False, classification=classification
        )

    @bot.slack_app.action(re.compile("silence_alert_.*"))
    async def handle_silence_alert(ack, body, say):
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


async def handle_feedback(bot, body, say, is_positive, classification):
    # Implementation of handle_feedback
    pass


async def silence_alert(alert_id: str) -> bool:
    alert_config = get_alert_configuration(alert_id)
    integration = IntegrationSourceFactory.get_integration(alert_config.provider)
    return await integration.silence_alert(alert_id)
