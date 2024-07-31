import json
from langchain import hub
from langchain.agents import AgentExecutor, create_react_agent
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

from app.ml.vector_store import VectorStore
from app.services.alert import get_alert_configuration_stats

PROMPT = """Analyze this alert and return a score between 0 and 1.
0 denotes that the alert is not actionable (noisy), while 1 denotes that the alert is actionable.
Return a number between 0 and 1.

Key things to consider when generating the output

Return a JSON dictionary with the following fields:
- score: The actionability score (float between 0 and 1)
- reasoning: A concise sentence explaining the prediction
- additional_info: The information described above based on the score. additional_info should be a dictionary.

Do not return the output in Markdown format.

The output should be a JSON dictionary.

Also provide additional information based on the score:

1. If the score is below 0.5 (noisy alert):
   - Explain why the alert is considered noisy
   - Reference prior Slack conversations in the same channel if provided.

2. If the score is 0.5 or above (actionable alert):
   - Provide a summary of the issue
   - Reference wiki documentation and runbooks if provided.
   - Mention prior Slack conversations that could help understand the issue better (if provided)

Consider the following about the historical data:
1. How many similar alerts were there in the past?
2. What percentage of these similar alerts were actionable?
3. For actionable alerts, what was the average thread length?
4. Are there any common patterns in the responses to actionable alerts?
5. What kind of actions or resolutions were typically taken for similar alerts?

Analyze the thread conversations in the historical data to understand:
- Common troubleshooting steps
- Typical resolution times
- Key personnel involved in resolving similar issues

Use this historical information to inform your decision about whether the current alert is likely to be actionable or noisy, and to suggest potential next steps or resolutions.

Alert Title: {alert_title}
Alert Description: {alert_description}

This is the alert id:
{alert_id}

"""


@tool
def fetch_historical_data(alert_title: str) -> str:
    """Get historical data for similar alerts from the vector store."""
    vector_store = VectorStore()
    query = f"{alert_title}"
    similar_alerts = vector_store.search_similar_alerts(query, k=5)

    historical_data = []
    for doc, score in similar_alerts:
        historical_alert = {
            "text": doc.page_content,
            "metadata": doc.metadata,
            "similarity": score,
        }
        historical_data.append(historical_alert)

    return historical_data


@tool
def fetch_alert_stats(alert_id: str) -> dict:
    """Get statistics for the current alert."""
    return get_alert_configuration_stats(alert_id)


class AlertPredictor:
    """Alert prediction service."""

    def __init__(self):
        """
        Initialize the AlertPredictor with LLMClient and VectorStore instances.
        """
        llm = ChatOpenAI(model_name="gpt-4o", verbose=True, temperature=0)
        tools = [
            fetch_historical_data,
            fetch_alert_stats,
        ]
        prompt = hub.pull("hwchase17/react")
        agent = create_react_agent(
            llm,
            tools,
            prompt,
        )
        self.agent_executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

    async def predict(self, input_data: dict, alert_id: str = None):
        """
        Predict the alert based on input data and alert statistics.

        Args:
            input_data (dict): The input data for the alert. This data can be used to find historical data.
            alert_id (str): The alert ID.

        Returns:
            dict: The prediction result as a JSON object.
        """
        query = self._create_prompt(alert_data=input_data, alert_id=alert_id)
        result = self.agent_executor.invoke({"input": query})
        return json.loads(result["output"])

    def _create_prompt(self, alert_data: dict, alert_id: str) -> str:
        """
        Create a prompt string from alert data and alert ID.

        Args:
            alert_data (dict): The alert data.
            alert_id (str): The alert ID.

        Returns:
            str: The formatted prompt string.
        """
        return PROMPT.format(
            alert_title=alert_data.get("title", ""),
            alert_description=alert_data.get("description", ""),
            alert_id=alert_id,
        )
