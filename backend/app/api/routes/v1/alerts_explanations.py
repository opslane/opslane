from fastapi import APIRouter, Depends, HTTPException
from typing import Dict, Any

from app.ml.alert_classifier import AlertClassifier
from app.dependencies import get_alert_classifier

router = APIRouter()

@router.get("/alerts/{alert_id}/explain", response_model=Dict[str, Any])
async def explain_alert_classification(
    alert_id: str,
    classifier: AlertClassifier = Depends(get_alert_classifier)
):
    """Get detailed explanation for why an alert was classified as actionable/non-actionable."""
    try:
        # Fetch alert from database
        alert = await get_alert_by_id(alert_id) 
        if not alert:
            raise HTTPException(status_code=404, detail="Alert not found")
            
        # Get classification with explanation
        result = classifier.classify(alert)
        
        return {
            "alert_id": alert_id,
            "classification": result,
            "explanation": result.get("explanation", {}),
            "confidence": result.get("confidence", 0.0)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))