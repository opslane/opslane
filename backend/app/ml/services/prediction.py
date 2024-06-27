"""Alert prediction service."""

import json

from app.integrations.prediction.openai import OpenAIClient

PROMPT = """Analyze this alert and return a number between 0 and 1.
0 denotes that the alert is not actionable, while 1 denotes that the alert is actionable.
Only return the number between 0 and 1.

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

        return openai_prediction

    def _create_prompt(self, alert_data: dict) -> str:
        # Create a prompt for OpenAI based on input_data
        return PROMPT.format(alert_text=json.dumps(alert_data))
