"""LLM Client for Prediction using LiteLLM"""

from litellm import acompletion
from app.core.config import settings


class LLMClient:
    """LLM Client for Prediction"""

    def __init__(self):
        self.provider = settings.LLM_PROVIDER
        self.api_key = settings.LLM_API_KEY
        self.api_base = settings.LLM_API_BASE

    async def get_completion(self, prompt: str, model: str = None):
        """Get completion from LLM API"""
        try:
            # If no specific model is provided,
            # use a default based on the provider
            if model is None:
                model = self._get_default_model()

            completion_kwargs = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
            }

            # Add api_base if it's set
            if self.api_base:
                completion_kwargs["api_base"] = self.api_base

            if self.api_key:
                completion_kwargs["api_key"] = self.api_key

            response = await acompletion(**completion_kwargs)
            return response.choices[0].message.content
        except Exception as e:
            print(f"Error calling LLM API: {str(e)}")
            return None

    def _get_default_model(self):
        """Get the default model based on the provider"""
        provider_models = {
            "openai": "gpt-4o",
            "anthropic": "claude-3.5-sonnet",
            "ollama": "ollama/dolphin-mistral",
        }
        return provider_models.get(self.provider.lower(), "gpt-4o")
