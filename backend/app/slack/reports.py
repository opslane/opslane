"""Functions for generating and formatting Slack reports."""

from typing import Dict, List, Any
from app.services.alert import get_alert_report_data


async def send_insight_report(say: callable) -> None:
    """
    Generate and send an insight report using the provided 'say' function.

    Args:
        say (callable): A function to send messages in Slack.

    Returns:
        None
    """
    report_data = get_alert_report_data()
    blocks = format_insight_report_blocks(report_data)
    await say(blocks=blocks)


def format_insight_report_blocks(report_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Format the insight report data into Slack blocks.

    Args:
        report_data (Dict[str, Any]): The report data containing alert information.

    Returns:
        List[Dict[str, Any]]: A list of Slack blocks representing the formatted report.
    """
    total_alerts = len(report_data["open_alerts"])
    noisy_alerts = report_data["noisy_alerts_count"]
    reduction_percentage = (
        (noisy_alerts / total_alerts) * 100 if total_alerts > 0 else 0
    )

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "Weekly Alert Insights Report",
                "emoji": True,
            },
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "plain_text",
                    "text": f"{report_data['start_date'].strftime('%B %d, %Y')} - {report_data['end_date'].strftime('%B %d, %Y')}",
                    "emoji": True,
                }
            ],
        },
        {"type": "divider"},
        {
            "type": "context",
            "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
        },
        {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_section",
                    "elements": [
                        {
                            "type": "text",
                            "text": "Total alerts triggered",
                            "style": {"bold": True},
                        },
                        {"type": "text", "text": f"\n{total_alerts}\n\n"},
                        {
                            "type": "text",
                            "text": "Alerts marked as noisy by Opslane",
                            "style": {"bold": True},
                        },
                        {"type": "text", "text": f"\n{noisy_alerts}\n\n"},
                        {
                            "type": "text",
                            "text": "Reduction in alert volume",
                            "style": {"bold": True},
                        },
                        {"type": "text", "text": f"\n{reduction_percentage:.0f}%"},
                    ],
                }
            ],
        },
        {
            "type": "context",
            "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
        },
        {"type": "divider"},
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": "📈 *Top 5 most frequent alerts*"},
        },
        {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_list",
                    "style": "ordered",
                    "indent": 0,
                    "border": 0,
                    "elements": [
                        {
                            "type": "rich_text_section",
                            "elements": [
                                {
                                    "type": "text",
                                    "text": f"{alert.title} ({alert.count} times)",
                                }
                            ],
                        }
                        for alert in report_data["top_alerts"]
                    ],
                }
            ],
        },
        {
            "type": "context",
            "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
        },
        {"type": "divider"},
        {
            "type": "context",
            "elements": [{"type": "plain_text", "text": " ", "emoji": True}],
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": "📆 *Daily Alert Volume*"},
        },
        {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_list",
                    "style": "ordered",
                    "indent": 0,
                    "border": 0,
                    "elements": [
                        {
                            "type": "rich_text_section",
                            "elements": [
                                {"type": "text", "text": f"{date} ({count} alerts)"}
                            ],
                        }
                        for date, count in report_data["daily_volume"]
                    ],
                }
            ],
        },
    ]

    blocks.extend(
        [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": "Noisiest Alerts",
                    "emoji": True,
                },
            },
            {"type": "divider"},
        ]
    )

    for alert in report_data["noisy_alerts"]:
        alert_id = alert.provider_id
        blocks.extend(
            [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": alert.name,
                    },
                    "accessory": {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Silence",
                            "emoji": True,
                        },
                        "value": f"silence_alert_{alert_id}",
                        "action_id": f"silence_alert_{alert_id}",
                    },
                },
                {"type": "divider"},
            ]
        )

    return blocks


def format_prediction_blocks(
    prediction: Dict[str, Any], confidence_threshold: float
) -> List[Dict[str, Any]]:
    """
    Format the prediction data into Slack blocks.

    Args:
        prediction (Dict[str, Any]): The prediction data containing alert classification information.
        confidence_threshold (float): The threshold for determining if an alert is actionable.

    Returns:
        List[Dict[str, Any]]: A list of Slack blocks representing the formatted prediction.
    """
    alert_classification = (
        "Actionable"
        if float(prediction["score"]) > confidence_threshold
        else "Potentially Noisy"
    )

    additional_info = []
    for k, v in prediction["additional_info"].items():
        if k == "slack_conversations":
            conversation_links = []
            for conv in v:
                user = conv.get("user", "Unknown")
                timestamp = conv.get("timestamp", "")
                message = conv.get("message", "")
                link = f"<slack://channel?team=T027FNUU9V2&id=C079ZECA30U&message={timestamp}|{user}: {message[:50]}...>"
                conversation_links.append(link)
            additional_info.append(f"• *{k}:*\n  " + "\n  ".join(conversation_links))
        else:
            additional_info.append(f"• *{k}:* {v}")

    additional_info_text = "\n".join(additional_info)

    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": f"Alert Classification: {alert_classification}",
                "emoji": True,
            },
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": prediction["reasoning"]},
        },
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*Additional Information:*\n{additional_info_text}",
            },
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "👍",
                        "emoji": True,
                    },
                    "value": alert_classification,
                    "action_id": "thumbs_up",
                    "style": "primary",
                },
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "👎",
                        "emoji": True,
                    },
                    "value": alert_classification,
                    "action_id": "thumbs_down",
                    "style": "danger",
                },
            ],
        },
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": "Please provide feedback on the classification to help improve future predictions.",
                }
            ],
        },
    ]

    return blocks
