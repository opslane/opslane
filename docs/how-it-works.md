# How Opslane works

Opslane turns your app's errors and session recordings into a short list of real problems and, where it can, pull requests that fix them. Here's the whole path, from an error in someone's browser to a PR in your repo.

### It captures everything and decides nothing yet

You install the SDK in your app. It catches errors and records what the user was doing (with form inputs masked), and sends both to Opslane. At this point Opslane just stores what happened. It doesn't open an issue or alert anyone. A single error firing once is not a reason to page you.

### It groups errors by where they actually happen

The same bug can hit 500 people and throw 500 errors. Opslane uses your source maps to turn the minified stack trace back into real file names, then groups by where the bug lives in your code. So 500 reports become one issue, and it stays one issue across deploys instead of splitting every time your bundle hash changes. A bug you fixed that comes back is marked as returned, not filed as new.

### It only investigates the errors that matter

Investigating an error costs real money, because it runs an AI agent over your code. So Opslane waits until an error has hit enough real users recently before it looks closer. Below that bar it keeps the issue and watches it, but doesn't investigate. For the ones above it, Opslane reads your repository and decides whether this is a real product problem or just noise from a browser extension or third-party script. Only the real ones move on.

### It investigates in your code

Opslane clones your repo at the version where the error happened and reads the code until it can point to the exact lines that caused it. It has to cite real files it actually opened; a guess that points at code that isn't there gets thrown out. At this stage it only reads.

### It writes a fix and proves it

When the cause is in your code, Opslane writes a fix and proves it in a sandbox before you see it. It runs your tests before and after the change, builds your project, and where it can, writes a test that fails on the broken code and passes on the fix. A second AI model reviews the diff and can reject it. Only then does a pull request open. [When Opslane opens a pull request](/architecture/precision/) covers what that check does and doesn't promise.

### What you get

Every issue ends one of three honest ways:

- **A pull request** with a fix Opslane checked. You review and merge; it never merges its own.
- **A note** that the problem is real but the cause is outside your code, so there's nothing to patch.
- **A stop with a plain reason** and a next step, when Opslane can't find a cause or is missing something it needs.

A daily digest sums up what broke, what got fixed, and what needs you. On a quiet day it says nothing.
