"""LLM Client for Prediction using LangChain"""

from langchain.chat_models import ChatOpenAI
from langchain.embeddings import OpenAIEmbeddings
from langchain.schema import HumanMessage

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
        response = await self.llm.agenerate([prompt])
        return response.generations[0][0].text

    def get_embedding(self, text: str):
        return self.embeddings.embed_query(text)
