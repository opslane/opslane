"""Command handlers for Slack slash commands."""

from app.slack.reports import send_insight_report


def register_command_handlers(bot):
    @bot.slack_app.command("/opslane")
    async def handle_opslane_command(ack, body, say):
        await ack()
        text = body.get("text", "").strip()
        user_id = body["user_id"]

        if text.startswith("insight"):
            await send_insight_report(say)
        else:
            await say(f"Unknown parameter: {text}. Please use 'insight' or 'train'.")
