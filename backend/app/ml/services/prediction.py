"""Alert prediction service."""

import asyncio
import json

from typing import Dict, Any

from langchain.schema import HumanMessage
from pydantic import BaseModel, Field

from app.integrations.prediction.llm import LLMClient
from app.ml.vector_store import VectorStore
from app.telemetry.events import ApplicationEvents
from app.telemetry.posthog import posthog_client


PROMPT = """Analyze this alert and return a score between 0 and 1.
0 denotes that the alert is not actionable (noisy), while 1 denotes that the alert is actionable.
Return a number between 0 and 1.

Key things to consider when generating the output

Return a JSON dictionary with the following fields:
- score: The actionability score (float between 0 and 1)
- reasoning: A concise sentence explaining the prediction
- additional_info: The information described above based on the score. additional_info should be a dictionary.

Do not return the output in Markdown format. The output should be a JSON dictionary.

Also provide additional information based on the score:

1. If the score is below 0.5 (noisy alert):
   - Explain why the alert is considered noisy
   - Reference prior Slack conversations in the same channel if provided.

2. If the score is 0.5 or above (actionable alert):
   - Provide a summary of the issue
   - Reference wiki documentation and runbooks if provided.
   - Mention prior Slack conversations that could help understand the issue better (if provided)

You should consider the following alert signals:

The signals are based on the order of priority. The higher the signal, the more important it is.

* Repetition of Alerts:
    * Frequent repetition of similar alerts over a short period.
    * Alerts that fire frequently tend to be more noisy. They are less actionable.
* Alert Duration
    * Short-lived alerts that auto-resolve quickly.
    * Alerts that resolve quickly are less actionable.
* 3. Lack of Response on Prior Alerts:
    * Alerts that have historically not been acknowledged or responded to.
    * Alerts that have not been acknowledged or responded to are less actionable.
* Severity: The level of impact or urgency
    * High severity alerts are more actionable.
* Correlation: Relationship with other alerts or system events


Actionable Alerts
* New Error Causes:
    * Detection of new types of errors that haven't occurred before.
    * An alert that has never been seen before is always actionable.
* High Alert Values:
    * Alerts with values significantly exceeding normal thresholds.

This is the alert text:

{alert_text}

These are the alert stats for this specific alert.

The field unique_open_alerts will tell you how many alerts of this type have been opened in the last 7 days.
If the field noisy_reason is provided and it is not "No reason provided", it means that the value of is_noisy field should be considered.
This input comes from the user and should be considered as the most important signal for the alert actionability.


{alert_stats}


Historical Data:
{historical_data}

Consider the following about the historical data:
1. How many similar alerts were there in the past?
2. What percentage of these similar alerts were actionable?
3. For actionable alerts, what was the average thread length?
4. Are there any common patterns in the responses to actionable alerts?
5. What kind of actions or resolutions were typically taken for similar alerts?

Analyze the thread conversations in the historical data to understand:
- Common troubleshooting steps
- Typical resolution times
- Key personnel involved in resolving similar issues

Use this historical information to inform your decision about whether the current alert is likely to be actionable or noisy, and to suggest potential next steps or resolutions.


"""


class AlertPrediction(BaseModel):
    score: float = Field(..., ge=0, le=1)
    reasoning: str
    additional_info: Dict[str, Any]


class AlertPredictor:
    """Alert prediction service."""

    def __init__(self):
        """
        Initialize the AlertPredictor with LLMClient and VectorStore instances.
        """
        self.llm_client = LLMClient()
        self.vector_store = VectorStore()

    async def predict(self, input_data: dict, alert_stats: dict = None):
        """
        Predict the alert based on input data and alert statistics.

        Args:
            input_data (dict): The input data for the alert.
            alert_stats (dict, optional): Statistics related to the alert. Defaults to None.

        Returns:
            dict: The prediction result as a JSON object.
        """
        historical_data = await self.fetch_historical_data(input_data)
        prompt = self._create_prompt(input_data, alert_stats, historical_data)

        messages = [
            HumanMessage(content=prompt),
        ]

        alert_prediction = await self.llm_client.get_completion(messages)
        posthog_client.capture(ApplicationEvents.ALERT_PREDICTION)

        try:
            prediction_dict = json.loads(alert_prediction)

            # Then, validate against our Pydantic model
            validated_prediction = AlertPrediction(**prediction_dict)
            return validated_prediction.model_dump()
        except json.JSONDecodeError:
            # Handle the case where the output is not valid JSON
            return {
                "error": "Failed to parse LLM output as JSON",
                "raw_output": alert_prediction,
            }

    def _create_prompt(
        self, alert_data: dict, alert_stats: dict, historical_data: list
    ) -> str:
        """
        Create a prompt string from alert data, statistics, and historical data.

        Args:
            alert_data (dict): The alert data.
            alert_stats (dict): The alert statistics.
            historical_data (list): Historical data for similar alerts.

        Returns:
            str: The formatted prompt string.
        """
        historical_data_str = json.dumps(historical_data, indent=2)
        return PROMPT.format(
            alert_text=json.dumps(alert_data),
            alert_stats=json.dumps(alert_stats),
            historical_data=historical_data_str,
        )

    def add_to_vector_store(self, alert_data: dict):
        """
        Add alert data to the vector store.

        Args:
            alert_data (dict): The alert data to be added.
        """

        text = f"{alert_data['title']} {alert_data['description']}"
        embedding = self.llm_client.get_embedding(text)

        self.vector_store.add_embeddings(
            [text], [embedding], [{"alert_id": alert_data["id"]}]
        )

    async def fetch_historical_data(self, alert_data: dict) -> list:
        """
        Fetch historical data for similar alerts.

        Args:
            alert_data (dict): The current alert data.

        Returns:
            list: A list of similar historical alerts with their metadata.
        """
        query = f"{alert_data.get('title', '')} {alert_data.get('description', '')}"
        similar_alerts = self.vector_store.search_similar_alerts(query, k=5)

        historical_data = []
        for doc, score in similar_alerts:
            historical_alert = {
                "text": doc.page_content,
                "metadata": doc.metadata,
                "similarity": score,  # This is now the similarity score
            }
            historical_data.append(historical_alert)

        return historical_data
