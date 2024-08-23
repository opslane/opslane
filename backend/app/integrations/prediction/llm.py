"""LLM Client for Prediction using LangChain"""

from langchain_openai import ChatOpenAI, OpenAIEmbeddings

from app.core.config import settings


class LLMClient:
    """LLM Client for Prediction"""

    def __init__(self):
        self.llm = ChatOpenAI(
            model_name="gpt-3.5-turbo",
            temperature=0,
            openai_api_key=settings.LLM_API_KEY,
        )
        self.embeddings = OpenAIEmbeddings(openai_api_key=settings.LLM_API_KEY)

    async def get_completion(self, prompt: str):
        """
        Get a completion from the LLM based on the given prompt.

        Args:
            prompt (str): The input prompt for the LLM.

        Returns:
            str: The generated completion text.
        """
        response = await self.llm.agenerate([prompt])
        return response.generations[0][0].text

    def get_embedding(self, text: str):
        """
        Get the embedding for the given text.

        Args:
            text (str): The input text to embed.

        Returns:
            list: The embedding vector for the input text.
        """
        return self.embeddings.embed_query(text)
