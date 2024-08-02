"""Base agent class for all agents."""

from typing import Any, Dict, List

from langchain import hub
from langchain.agents import AgentExecutor, create_react_agent, Tool
from langchain.prompts import PromptTemplate
from langchain.prompts.chat import (
    ChatPromptTemplate,
    SystemMessagePromptTemplate,
    HumanMessagePromptTemplate,
)
from langchain_openai import ChatOpenAI


class BaseAgent:
    """Base agent class that initializes and runs an agent executor."""

    def __init__(self, tools: List[Tool], prompt: PromptTemplate):
        """
        Initialize the BaseAgent.

        Args:
            tools (List[Tool]): A list of tools available to the agent.
            prompt (PromptTemplate): The prompt template for the agent.
        """
        llm = ChatOpenAI(model_name="gpt-4", verbose=True, temperature=0)
        react_prompt = hub.pull("hwchase17/react")
        system_message_prompt = SystemMessagePromptTemplate.from_template(
            react_prompt.template
        )
        human_message_prompt = HumanMessagePromptTemplate.from_template(prompt.template)

        # Combine React prompt with custom prompt
        combined_prompt = ChatPromptTemplate.from_messages(
            [system_message_prompt, human_message_prompt]
        )
        agent = create_react_agent(
            llm,
            tools,
            combined_prompt,
        )

        self.agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)
        self.prompt = prompt

    def run(self, query: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the agent executor with the given query.

        Args:
            query (Dict[str, Any]): The input query for the agent.

        Returns:
            Dict[str, Any]: The output from the agent executor.
        """
        pass
