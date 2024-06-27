from pydantic import BaseModel


class SlackFormData(BaseModel):
    api_app_id: str
    channel_id: str
    channel_name: str
    command: str
    is_enterprise_install: bool
    response_url: str
    team_domain: str
    team_id: str
    text: str = ""
    token: str
    trigger_id: str
    user_id: str
    user_name: str
