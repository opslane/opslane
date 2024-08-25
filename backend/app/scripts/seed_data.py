from app.integrations.documents.slack import index_slack_content


def seed_data():
    # 1. Index Slack Content
    index_slack_content()


if __name__ == "__main__":
    seed_data()
