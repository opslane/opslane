"""LLM Client for Prediction using LiteLLM"""

from litellm import acompletion
from app.core.config import settings


class LLMClient:
    """LLM Client for Prediction"""

    def __init__(self):
        self.provider = settings.LLM_PROVIDER
        self.api_key = settings.LLM_API_KEY

    async def get_completion(self, prompt: str, model: str = None):
        """Get completion from LLM API"""
        try:
            # If no specific model is provided,
            # use a default based on the provider
            if model is None:
                model = self._get_default_model()

            response = await acompletion(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                api_key=self.api_key,
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling LLM API: {str(e)}")
            return None

    def _get_default_model(self):
        """Get the default model based on the provider"""
        provider_models = {
            "openai": "gpt-4o",
            "anthropic": "claude-3.5-sonnet",
        }
        return provider_models.get(self.provider.lower(), "gpt-4o")
