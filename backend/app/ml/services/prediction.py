"""Alert prediction service."""

import json

from app.integrations.prediction.openai import OpenAIClient

PROMPT = """Analyze this alert and return a score between 0 and 1.
0 denotes that the alert is not actionable, while 1 denotes that the alert is actionable.
Return a number between 0 and 1.

Also give your reasoning for the prediction.

The reasoning should be concise and to the point.
Return JSON Dictionary where there are two fields.
One field is the score and the other is the reasoning.
The reasoning should be one sentence explaining the prediction.

Do not return the output in Markdown format.

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
"""


class AlertPredictor:
    """Alert prediction service."""

    def __init__(self):
        self.openai_client = OpenAIClient()

    async def predict(self, input_data: dict):
        """Make a prediction based on input_data"""
        # Get prediction from OpenAI
        prompt = self._create_prompt(input_data)
        openai_prediction = await self.openai_client.get_completion(prompt)

        return json.loads(openai_prediction)

    def _create_prompt(self, alert_data: dict) -> str:
        # Create a prompt for OpenAI based on input_data
        return PROMPT.format(alert_text=json.dumps(alert_data))
