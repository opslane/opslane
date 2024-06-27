"""OpenAI Client for Prediction"""

from openai import AsyncOpenAI
from app.core.config import settings


class OpenAIClient:
    """OpenAI Client for Prediction"""

    def __init__(self):
        self.client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    async def get_completion(self, prompt: str, model: str = "gpt-4o"):
        """Get completion from OpenAI API"""
        try:
            response = await self.client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": prompt}]
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling OpenAI API: {str(e)}")
            return None
