<div align="center">
 <img alt="opslane" height="200px" src="https://path-to-your-logo.png">
</div>

# Opslane

[![Discord](https://dcbadge.vercel.app/api/server/opslane?style=flat&compact=true)](https://discord.gg/opslane)

Opslane is a tool that helps on-call engineers reduce alert fatigue by classifying alerts as actionable or noisy, grouping related alerts, and providing contextual information for handling alerts.

## Quickstart

To run Opslane:

```bash
docker run -d -p 8080:8080 opslane/opslane
```

## Features

- Ingests alerts from Datadog and Sentry via webhooks
- Integrates with knowledge bases like Confluence, Slack, and Google Drive
- Operates primarily in the Slack channel where a team receives alerts
- Uses LLM / ML prediction to classify alerts as actionable or noisy
- Provides additional resources for debugging actionable alerts

## System Architecture

[Insert a diagram of your system architecture here]

## Installation

### Prerequisites

- Docker
- Slack workspace
- Datadog and/or Sentry account

### Setup

1. Clone the repository:
```bash
   git clone https://github.com/yourusername/opslane.git
```

2. Configure environment variables:

```bash
bash
cp .env.example .env
# Edit .env with your Slack, Datadog, and Sentry API keys
```


3. Build and run the Docker container:

```bash

   docker build -t opslane .
   docker run -d -p 8080:8080 --env-file .env opslane

```


## Usage

1. Add the Opslane bot to your Slack workspace
2. Configure Datadog and Sentry to send alerts to Opslane's webhook endpoint
3. Opslane will automatically analyze incoming alerts and post insights in your Slack channel

## API Reference

Opslane provides a REST API for alert management. See the [API documentation](./docs/api.md) for details.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for more details.

## Community

