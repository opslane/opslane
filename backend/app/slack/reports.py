"""Functions for generating and formatting Slack reports."""

import json
from typing import Dict, List, Any

from app.agents.rca import RCAOutput, CodeChange
from app.agents.confluence import ConfluenceKBOutput
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
    prediction: Dict[str, Any], alert_data: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """
    Format the prediction data into Slack blocks, including root cause analysis.

    Args:
        prediction (Dict[str, Any]): The prediction data containing alert classification information.
        confidence_threshold (float): The threshold for determining if an alert is actionable.
        root_cause (Dict[str, Any]): The root cause analysis data.

    Returns:
        List[Dict[str, Any]]: A list of Slack blocks representing the formatted prediction and root cause analysis.
    """
    value_dict = {
        "is_actionable": prediction["is_actionable"],
        "alert_id": alert_data["alert_id"],
        "alert_configuration_id": alert_data["alert_configuration_id"],
    }
    value = json.dumps(value_dict)

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
                    "value": value,
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
                    "value": value,
                    "action_id": "thumbs_down",
                    "style": "danger",
                },
            ],
        },
    ]

    return blocks


def create_rca_blocks(rca_result: RCAOutput) -> List[Dict]:
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": "Root Cause Analysis Results",
                "emoji": True,
            },
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*Summary:*\n{rca_result.summary}"},
        },
        {"type": "divider"},
    ]

    if rca_result.issues:
        issues_text = "\n".join(
            [f"• <{issue.log_link}|{issue.summary}>" for issue in rca_result.issues]
        )
        blocks.extend(
            [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Potential Issues:*\n{issues_text}",
                    },
                },
                {"type": "divider"},
            ]
        )

    if rca_result.code_changes:
        code_changes_text = "\n".join(
            [
                f"• Commit: `{change.commit_hash}`(<{change.link}|link>) \n  Author: {change.author}\n  Title: {change.title}"
                for change in rca_result.code_changes
            ]
        )
        blocks.extend(
            [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Suspicious Code Changes:*\n{code_changes_text}",
                    },
                },
                {"type": "divider"},
            ]
        )

    if rca_result.runbook_step_results:
        blocks.extend(
            [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Suspicious Runbook Investigation:*\n{rca_result.runbook_step_results}",
                    },
                },
                {"type": "divider"},
            ]
        )

    if rca_result.remediation:
        remediation_text = "\n".join([f"• {step}" for step in rca_result.remediation])
        blocks.extend(
            [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": f"*Recommended Remediation Steps:*\n{remediation_text}",
                    },
                },
                {"type": "divider"},
            ]
        )

    return blocks


def create_confluence_blocks(document: dict) -> List[Dict]:
    """
    Create Slack blocks for Confluence KB results.

    Args:
        confluence_result (ConfluenceKBOutput): The Confluence KB output containing relevant documents.

    Returns:
        List[Dict]: A list of Slack blocks representing the Confluence results.
    """
    if not document:
        return []

    confluence_text = f"• <{document['source']}|{document['title']}>"

    return [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*Relevant Confluence Documents:*\n{confluence_text}",
            },
        },
        {"type": "divider"},
    ]
