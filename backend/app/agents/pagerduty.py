import json
from typing import Dict, Any
from langchain_core.pydantic_v1 import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

from app.agents.base import BaseAgent
from app.tools.pagerduty import get_alert_id, fetch_pagerduty_incident_alert


class DatadogQueryOutput(BaseModel):
    """Output schema for Datadog query generation."""

    query: str = Field(description="The Datadog log query")
    alert_summary: str = Field(description="A summary of the alert description")


class PagerDutyAgent(BaseAgent):
    """Agent for generating Datadog log queries based on PagerDuty alerts."""

    def __init__(self):
        """Initialize the PagerDutyAgent with a specific prompt template."""
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    """
            <instructions>
            You are an AI assistant with expertise in Datadog log queries.
            You are tasked with generating a Datadog log query based on an alert description.

            The query should include relevant service names, environments, and error statuses.
            Only add tags that are mentioned in the alert description.
            Do not add any tags that are not in the alert description.

            Example of Generated Query: env:production service:api-server status:error

            </instructions>
            \nHere is the user provided alert description:""",
                ),
                ("placeholder", "{messages}"),
            ]
        )
        super().__init__(DatadogQueryOutput, prompt)

    def run(self, incident_id: str) -> Dict[str, Any]:
        """
        Generate a Datadog log query based on a PagerDuty incident.

        Args:
            incident_id (str): The ID of the PagerDuty incident.

        Returns:
            Dict[str, Any]: A dictionary containing the generated Datadog query and alert summary.
        """
        alert_id = get_alert_id(incident_id=incident_id)
        alert_data = fetch_pagerduty_incident_alert(
            incident_id=incident_id, alert_id=alert_id
        )
        alert_str = json.dumps(alert_data)

        messages = [
            ("user", f"What is the datadog log query for this alert? {alert_str}")
        ]
        return self.run_chain({"messages": messages})


pagerduty_agent = PagerDutyAgent()
