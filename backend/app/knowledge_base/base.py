from abc import ABC, abstractmethod


class BaseKnowledgeBaseIntegrator(ABC):
    @abstractmethod
    def process_content(self):
        pass

    @abstractmethod
    def search_knowledge_base(self, query: str, k: int = 5):
        pass
