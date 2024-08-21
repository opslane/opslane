
<p align="center">
  <img alt="logo" src="./assets/opslane-logo-large.png" width="300">
</p>

<p align="center">
  <a href="https://oposlane.com">Website</a> &bull;
  <a href="https://docs.opslane.com">Docs</a> &bull;
  <a href="https://youtu.be/m_K9Dq1kZDw">Demo</a> &bull;
  <a href="https://cal.com/team/opslane/demo">Book a call</a> &bull;
  <a href="https://join.slack.com/t/opslanecommunity/shared_invite/zt-2ncr7a1tx-8YAdUoVHJX0qgCF31PATuA">Join Community</a>
</p>

### Opslane is an AI On-Call Co-Pilot

[![Docs](https://img.shields.io/badge/docs-docs.opslane.com-3F16E4)](https://docs.opslane.com) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-purple.svg)](https://github.com/opslane/opslane/blob/main/LICENSE.md) [![Slack](https://img.shields.io/badge/slack-opslane-red.svg)](https://join.slack.com/t/opslanecommunity/shared_invite/zt-2ncr7a1tx-8YAdUoVHJX0qgCF31PATuA)

Opslane is an open-source tool designed to make the on-call experience less stressful.

It leverages AI to reduce alert fatigue, provide contextual information, and automate routine tasks.

[![Demo CountPages alpha](./assets/opslane-demo.gif)](https://youtu.be/m_K9Dq1kZDw)

## Why did we build Opslane?

Most engineers don't enjoy being on-call.

These are some of the main reasons why:
- **Alert fatigue**: Engineers receive too many alerts, many of which are noisy.
- **Lack of context**: It's challenging to understand the root cause of an incident.
- **Manual incident resolution**: It's time-consuming to look through runbooks and logs to resolve incidents.
- **Monitoring tool overload**: Engineers use multiple monitoring tools, each with its own set of alerts.
- **Burnout**: The stress of being on-call can lead to burnout and decreased productivity.

Opslane addresses these challenges by building an AI-powered on-call co-pilot that makes on-call duties more manageable.

## Status

Opslane is currently in beta. We are actively working on improving the product and adding new features.

### Roadmap

- [ ] **Intelligent Alert Management**
  - [X] Classify alerts as actionable or noisy using AI
  - [ ] Group related alerts for easier management
  - [ ] Provide historical context and runbooks for alerts

- [ ] **Analytics and Reporting**
  - [X] Weekly alert quality reports
  - [ ] Identify patterns in alert frequency and timing
  - [X] One-click option to silence noisy alerts

- [ ] **Root Cause Analysis**
  - [ ] Correlate issues across multiple systems
  - [ ] Automate initial debugging steps
  - [ ] Suggest potential root causes

- [ ] **Runbook Automation**
  - [ ] Automate common incident resolution steps using runbooks

- [ ] **Gruntwork Automation**
  - [ ] Generate on-call handoff documents
  - [ ] Integrate with PagerDuty/OpsGenie for scheduling overrides
  - [ ] Automatically update Slack with current on-call engineer

- [ ] **Slack Integration**
  - [X] Operate directly in your alert Slack channels
  - [X] Provide insights and debugging resources in-context


## Integrations

We use a flexible data model so that we can support multiple integrations. Currently, Opslane supports Datadog.

## Installation

### Prerequisites

- Docker
- Slack workspace
- Datadog account

### Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/opslane.git
cd opslane
```

2. Configure environment variables:

```bash
cp .env.example .env
# Edit .env with your Slack, Datadog, and OpenAI API keys
```


3. Build and run the Docker container:

```bash
docker-compose up --build
```

## Usage

1. Add the Opslane bot to the Slack channel where you receive alerts
2. Configure Datadog to send alerts to Opslane's webhook endpoint
3. Opslane will automatically analyze incoming alerts and post insights in your Slack channel

## Community

The Opslane community can be found on [GitHub Discussions](https://github.com/opslane/opslane/discussions), and our [Slack community](https://join.slack.com/t/opslanecommunity/shared_invite/zt-2ncr7a1tx-8YAdUoVHJX0qgCF31PATuA).

Ask questions, report bugs, join discussions, voice ideas, make feature requests, or share your projects.

## Telemetry

We capture anonymized telemetry to understand usage patterns.

This helps us:

- Improve Opslane based on usage patterns
- Track usage for internal metrics

We collect minimal, non-sensitive data and do not share it with third parties.

If you prefer to opt out of telemetry, set `ANONYMIZED_TELEMETRY=False` in the .env file.
