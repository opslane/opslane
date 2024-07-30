import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from app.ml.services.prediction import AlertPredictor, AlertPrediction


@pytest.fixture
def alert_predictor():
    with patch("app.ml.services.prediction.LLMClient") as mock_llm_client, patch(
        "app.ml.services.prediction.VectorStore"
    ) as mock_vector_store:
        predictor = AlertPredictor()
        predictor.llm_client = mock_llm_client
        predictor.vector_store = mock_vector_store
        yield predictor


@pytest.mark.asyncio
async def test_predict_noisy_alert(alert_predictor):
    input_data = {
        "title": "Frequent Low CPU Usage",
        "description": "CPU usage below 10% for 30 minutes",
        "severity": "low",
    }
    alert_stats = {
        "unique_open_alerts": 50,
        "is_noisy": True,
        "noisy_reason": "Frequent occurrence",
    }

    # Mock the LLM response
    mock_llm_response = (
        '{"score": 0.2, "reasoning": "This alert is noisy", "additional_info": {}}'
    )
    alert_predictor.llm_client.get_completion = AsyncMock(
        return_value=mock_llm_response
    )

    # Mock the historical data
    alert_predictor.fetch_historical_data = AsyncMock(return_value=[])

    result = await alert_predictor.predict(input_data, alert_stats)

    assert isinstance(result, dict)
    assert 0 <= result["score"] <= 1
    assert result["score"] < 0.5
    assert "noisy" in result["reasoning"].lower()


@pytest.mark.asyncio
async def test_predict_actionable_alert(alert_predictor):
    input_data = {
        "title": "Critical Database Failure",
        "description": "Primary database is down",
        "severity": "critical",
    }
    alert_stats = {
        "unique_open_alerts": 1,
        "is_noisy": False,
        "noisy_reason": "No reason provided",
    }

    # Mock the LLM response
    mock_llm_response = (
        '{"score": 0.8, "reasoning": "This alert is actionable", "additional_info": {}}'
    )
    alert_predictor.llm_client.get_completion = AsyncMock(
        return_value=mock_llm_response
    )

    # Mock the historical data
    alert_predictor.fetch_historical_data = AsyncMock(return_value=[])

    result = await alert_predictor.predict(input_data, alert_stats)

    assert isinstance(result, dict)
    assert 0 <= result["score"] <= 1
    assert result["score"] >= 0.5
    assert "actionable" in result["reasoning"].lower()


def test_create_prompt(alert_predictor):
    alert_data = {"title": "Test Alert", "description": "Test Description"}
    alert_stats = {"unique_open_alerts": 5}
    historical_data = [{"text": "Previous similar alert", "metadata": {}}]

    prompt = alert_predictor._create_prompt(alert_data, alert_stats, historical_data)

    assert isinstance(prompt, str)
    assert "Test Alert" in prompt
    assert "Test Description" in prompt
    assert "Previous similar alert" in prompt


@pytest.mark.asyncio
async def test_fetch_historical_data(alert_predictor):
    alert_data = {"title": "Test Alert", "description": "Test Description"}

    # Mock the vector store search
    mock_search_results = [
        (MagicMock(page_content="Similar alert 1", metadata={"id": "1"}), 0.9),
        (MagicMock(page_content="Similar alert 2", metadata={"id": "2"}), 0.8),
    ]
    alert_predictor.vector_store.search_similar_alerts = MagicMock(
        return_value=mock_search_results
    )

    historical_data = await alert_predictor.fetch_historical_data(alert_data)

    assert isinstance(historical_data, list)
    assert len(historical_data) == 2  # We mocked 2 similar alerts
    for item in historical_data:
        assert "text" in item
        assert "metadata" in item
        assert "similarity" in item

    # Verify that the vector store was called with the correct query
    alert_predictor.vector_store.search_similar_alerts.assert_called_once_with(
        "Test Alert Test Description", k=5
    )
