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


def format_prediction_blocks(prediction: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Format the prediction data into Slack blocks, including root cause analysis.

    Args:
        prediction (Dict[str, Any]): The prediction data containing alert classification information.
        confidence_threshold (float): The threshold for determining if an alert is actionable.
        root_cause (Dict[str, Any]): The root cause analysis data.

    Returns:
        List[Dict[str, Any]]: A list of Slack blocks representing the formatted prediction and root cause analysis.
    """
    blocks = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": prediction["summary"]},
        },
        {"type": "divider"},
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
                    "value": prediction["is_actionable"],
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
                    "value": prediction["is_actionable"],
                    "action_id": "thumbs_down",
                    "style": "danger",
                },
            ],
        },
    ]

    return blocks
