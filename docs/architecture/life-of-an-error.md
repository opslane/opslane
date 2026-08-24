---
covers:
  - packages/sdk/**
  - packages/ingestion/**
  - packages/worker/**
description: One error from capture through investigation, verification, and delivery.
---

# Life of an error

Follow one browser error from the moment it's thrown to what comes out the other end: a pull request, an insight, or an honest reason Opslane couldn't fix it.

## 1. Capture, in the browser

The SDK catches the error, attaches breadcrumbs (console, network, navigation) and network timings, and strips tokens and credentials from the text and URLs before sending anything. If session recording is on, and it is by default, the error also points into a masked recording of what the user was doing. The SDK sends all of this to the ingestion service and decides nothing else.

## 2. Store and group, in ingestion

Ingestion authenticates the event, drops known noise (browser-extension stacks, cross-origin `Script error.` with no frames), and masks sensitive fields again on the server. Then it stores the event. It does not create an issue or fire an alert yet.

Grouping happens after the stack-resolution job finishes, not during capture. Ingestion records aliases for both the raw and resolved stack identities and points them at one canonical issue. Those aliases keep one bug attached to one issue across deploys, including when a source map arrives after the event.

## 3. Decide whether it's worth investigating

Opslane doesn't investigate every issue. A cheap, mechanical filter checks whether the issue has reached enough real users recently, inside the environments you allow automation in. An issue below that bar is watched, not investigated.

An issue that clears the bar goes to an inquiry: a read-only agent that reads the evidence and your repository and decides one of three things. Investigate it now, wait for more evidence, or don't pursue it (third-party noise, a browser extension, too little to act on). An issue told to wait comes back when new evidence arrives.

## 4. Investigate, read-only

When the inquiry says investigate, the worker clones your repository at the commit tied to the evidence. A read-only agent examines the code until it can name a cause and cite the exact files. Opslane checks those citations: a cause that points at files the agent never opened, or at code that isn't there, is discarded. Nothing runs at this stage. The E2B sandbox is created later, when Opslane attempts a fix.

## 5. Fix and verify

For an error with a cause in your code, the worker creates a fix job immediately. Error fixes have no additional confidence, reach, or approval gate. In the sandbox, Opslane runs the existing tests before and after the edit, builds the changed repository, and, where possible, proves a test fails on the broken code and passes on the fix. A second model then reviews the diff and evidence and can reject the candidate. What that proof means, and what it doesn't, is in [precision](precision.md).

## 6. What comes out

An investigation ends one of three ways:

- **A pull request** with a fix Opslane verified.
- **An insight.** The user pain is real, but the cause is outside your code, so there's nothing to patch.
- **A stop with a reason.** Opslane couldn't establish a cause, or it's missing a credential or evidence it needs. The issue records a reason code and a next step; see [reason codes](../reference/reason-codes.md).

Friction issues, such as rage clicks, dead clicks, and form abandonment, follow a nearby path with a separate approval setting. See [friction and session recordings](../guides/friction.md).

## 7. Retries

Every job runs under a lease. If a worker dies mid-job, the lease expires and the work is retried with backoff, so a crash costs time but not the result.
