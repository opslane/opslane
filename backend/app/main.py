"""Main application."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.api.auth_check import enforce_authentication
from app.core.config import settings
from app.slack.bot import slack_handler
from app.agents.pagerduty import pagerduty_agent


def create_app() -> FastAPI:
    """Create the FastAPI application."""

    app = FastAPI(title="Opslane API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000"],  # Add your frontend URL here
        allow_credentials=True,
        allow_methods=["*"],  # Allows all methods
        allow_headers=["*"],  # Allows all headers
    )

    # Include API routers
    app.include_router(api_router, prefix=settings.API_V1_STR)

    @app.post("/slack/events")
    async def slack_events(request: Request):
        return await slack_handler.handle(request)

    @app.get("/trigger")
    async def trigger(request: Request):
        from app.agents.pagerduty import pagerduty_agent

        # from app.tools.datadog import fetch_datadog_logs
        # from app.tools.github import get_latest_git_changes
        # from app.agents.rca import rca_agent

        result = pagerduty_agent.run(incident_id="Q3BT1TAWL912X8")
        # logs = fetch_datadog_logs(result.query)[:10000]
        # git_changes = get_latest_git_changes()
        # result = rca_agent.run(
        #     alert_description="test",
        #     log_lines=logs,
        #     code_changes=git_changes,
        # )
        return result

        # return pagerduty_agent.run(incident_id="Q0KJP20KFLKEOH")

    # Enforce authentication on routes
    enforce_authentication(app)

    return app
