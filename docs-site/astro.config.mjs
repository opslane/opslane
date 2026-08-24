import { fileURLToPath } from 'node:url';

import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import mermaid from 'astro-mermaid';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

import remarkRepoLinks from './src/remark-repo-links.ts';
import remarkStripH1 from './src/remark-strip-h1.ts';
import { REPO_URL } from './src/repo.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig({
  site: 'https://docs.opslane.com',
  redirects: {
    '/replay-privacy': '/guides/replay-privacy',
  },
  markdown: {
    processor: unified({
      remarkPlugins: [[remarkRepoLinks, { repoRoot }], remarkStripH1],
    }),
  },
  integrations: [
    mermaid({ enableLog: false }),
    starlight({
      title: 'Opslane',
      customCss: ['./src/styles/theme.css'],
      description: 'An open-source error tracker that finds the bugs reaching your users and opens a pull request that fixes them.',
      markdown: { processedDirs: ['../docs'] },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: REPO_URL,
        },
      ],
      plugins: [
        starlightLinksValidator({ exclude: ['http://localhost:8082'] }),
        starlightLlmsTxt({
          description:
            'Opslane watches errors and session recordings from a web app, investigates the ones worth fixing against the connected repository, and opens a pull request whose build and tests ran in a sandbox. When it cannot fix something it records a reason code.',
          details: [
            'Self-hosted with Docker Compose. JavaScript browser errors and GitHub repositories are supported end to end.',
            'Reference tables (SDK options, HTTP routes, environment variables, reason codes) are checked against source on every CI run, so they are the authoritative answer for exact names and values.',
            'Keys come in two scopes: opslane_pk_ ingest keys ship in the browser bundle, opslane_sk_ source-map keys stay in CI.',
          ].join(' '),
          // Reference pages carry the exact names an agent needs; keep them
          // early so a truncated context still contains them.
          promote: ['index', 'install', 'quickstart/**', 'reference/**'],
          minify: false,
          // A reference-only bundle: an agent that needs an exact option,
          // route, variable, or reason code fetches this instead of 200 KB.
          customSets: [
            {
              label: 'Reference only',
              description: 'SDK options, HTTP routes, environment variables, and reason codes',
              slug: 'reference',
              paths: ['reference/**'],
            },
          ],
          // llms.txt otherwise lists only the two bundles, leaving an agent
          // with no routing. These are the task pages, with their URLs.
          optionalLinks: [
            { label: 'Run Opslane locally', url: 'https://docs.opslane.com/quickstart/self-host/', description: 'Docker Compose stack and a first event' },
            { label: 'Install the SDK', url: 'https://docs.opslane.com/install/', description: 'React, Vue, or vanilla setup, identity, and environment labels' },
            { label: 'Connect GitHub', url: 'https://docs.opslane.com/guides/github-app/', description: 'GitHub App or token, permissions, webhooks' },
            { label: 'Source maps', url: 'https://docs.opslane.com/guides/source-maps/', description: 'Vite plugin and OPSLANE_SOURCEMAP_KEY' },
            { label: 'How Opslane works', url: 'https://docs.opslane.com/how-it-works/', description: 'From captured errors to verified fix pull requests' },
            { label: 'Friction and session recordings', url: 'https://docs.opslane.com/guides/friction/', description: 'Rage clicks, dead clicks, and promotion' },
            { label: 'Environments', url: 'https://docs.opslane.com/guides/environments/', description: 'Labels, the project default, and action scope' },
            { label: 'API keys', url: 'https://docs.opslane.com/guides/api-keys/', description: 'Ingest keys, source-map keys, minting, rotation' },
            { label: 'Slack notifications', url: 'https://docs.opslane.com/guides/slack-notifications/', description: 'Webhooks, alerts, and the daily digest' },
            { label: 'Your data', url: 'https://docs.opslane.com/architecture/trust/', description: 'What Opslane collects and what each integration sends out' },
            { label: 'SDK options', url: 'https://docs.opslane.com/reference/sdk-options/', description: 'Every init() option with type and default' },
            { label: 'Reason codes', url: 'https://docs.opslane.com/reference/reason-codes/', description: 'Every needs_human code with its remediation' },
            { label: 'Environment variables', url: 'https://docs.opslane.com/reference/environment-variables/', description: 'Every variable each service reads' },
            { label: 'HTTP routes', url: 'https://docs.opslane.com/reference/http-routes/', description: 'Every route with its auth mode' },
          ],
        }),
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Introduction', link: '/' },
            { label: 'Run Opslane locally', slug: 'quickstart/self-host' },
            { label: 'Install the SDK', slug: 'install' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'How Opslane works', slug: 'how-it-works' },
            { label: "Catching bugs that don't throw", slug: 'guides/friction' },
            { label: 'When Opslane opens a pull request', slug: 'architecture/precision' },
          ],
        },
        {
          label: 'Connect your project',
          items: [
            { label: 'Connect GitHub', slug: 'guides/github-app' },
            { label: 'Upload source maps', slug: 'guides/source-maps' },
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'Notifications', slug: 'guides/slack-notifications' },
          ],
        },
        {
          label: 'Privacy and data',
          items: [
            { label: 'Your data', slug: 'architecture/trust' },
            { label: 'Replay privacy and masking', slug: 'guides/replay-privacy' },
            { label: 'Source-map privacy', slug: 'guides/source-map-privacy' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'SDK options', slug: 'reference/sdk-options' },
            { label: 'HTTP routes', slug: 'reference/http-routes' },
            { label: 'Reason codes', slug: 'reference/reason-codes' },
            { label: 'Environment variables', slug: 'reference/environment-variables' },
            { label: 'API keys', slug: 'guides/api-keys' },
          ],
        },
      ],
    }),
  ],
});
