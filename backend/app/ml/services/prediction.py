"""Alert prediction service."""

import json

from langchain.schema import HumanMessage, SystemMessage

from app.integrations.prediction.llm import LLMClient
from app.ml.vector_store import VectorStore


PROMPT = """Analyze this alert and return a score between 0 and 1.
0 denotes that the alert is not actionable (noisy), while 1 denotes that the alert is actionable.
Return a number between 0 and 1.

Key things to consider when generating the output

Return a JSON dictionary with the following fields:
- score: The actionability score (float between 0 and 1)
- reasoning: A concise sentence explaining the prediction
- additional_info: The information described above based on the score

Do not return the output in Markdown format. The output should be a JSON dictionary.


For the purposes of this demo, it's okay to generate realistic test data for all responses.

Also provide additional information based on the score:

1. If the score is below 0.5 (noisy alert):
   - Explain why the alert is considered noisy
   - Provide a fictional but realistic link to the alert history
   - Reference fictional but plausible Slack conversations in the same channel

2. If the score is 0.5 or above (actionable alert):
   - Provide a summary of the issue
   - Reference fictional but realistic wiki documentation and runbooks
   - Mention fictional but plausible prior Slack conversations that could help understand the issue better


Generate realistic-looking data for all fields, including plausible links, conversation snippets, and documentation references.

You should consider the following alert signals:


Signals
* Repetition of Alerts:
    * Frequent repetition of similar alerts over a short period.
* Alert Duration
    * Short-lived alerts that auto-resolve quickly.
* 3. Lack of Response on Prior Alerts:
    * Alerts that have historically not been acknowledged or responded to.
* Severity: The level of impact or urgency
* Correlation: Relationship with other alerts or system events


Actionable Alerts
* New Error Causes:
    * Detection of new types of errors that haven't occurred before.
* High Alert Values:
    * Alerts with values significantly exceeding normal thresholds.

1. Symptom-based vs. Cause-based Alert:

Derive from the alert title and description
Use NLP techniques to classify alerts as symptom-based or cause-based

Alerts should be on symptoms not causes. Cause based alerts are less actionable.


2. Golden Signal Category:

Categorize each alert into latency, traffic, errors, or saturation

Use keyword matching in the alert name and description

Alerts that fall into the errors category are more actionable.


3. Alert Frequency:

Count the number of times this specific alert has fired in the 7 days

Alerts that fire frequently tend to be more noisy. They are less actionable.

4. Alert Duration:

Calculate the average duration of this alert when it fires

Alerts that resolve quickly are less actionable.

This is the alert text:

{alert_text}

These are the alert stats for this specific alert.  The field unique_open_alerts will tell you how many alerts of this type have been opened in the last 7 days.

{alert_stats}

"""


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
        prompt = self._create_prompt(input_data, alert_stats)
        relevant_docs = self.vector_store.similarity_search(prompt)
        context = "\n\n".join(doc.page_content for doc in relevant_docs)

        messages = [
            SystemMessage(content=f"Context: {context}"),
            HumanMessage(content=prompt),
        ]

        alert_prediction = await self.llm_client.get_completion(messages)

        try:
            return json.loads(alert_prediction)
        except json.JSONDecodeError:
            # Handle the case where the output is not valid JSON
            return {
                "error": "Failed to parse LLM output as JSON",
                "raw_output": alert_prediction,
            }

    def _create_prompt(self, alert_data: dict, alert_stats: dict) -> str:
        """
        Create a prompt string from alert data and statistics.

        Args:
            alert_data (dict): The alert data.
            alert_stats (dict): The alert statistics.

        Returns:
            str: The formatted prompt string.
        """
        return PROMPT.format(
            alert_text=json.dumps(alert_data), alert_stats=json.dumps(alert_stats)
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
