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
      description: 'Errors in, verified fix PRs out — or an explicit incident that says why not.',
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
            { label: 'How issues work', url: 'https://docs.opslane.com/guides/issues/', description: 'Grouping, ranking, statuses, dropped noise' },
            { label: 'Friction and session recordings', url: 'https://docs.opslane.com/guides/friction/', description: 'Rage clicks, dead clicks, and promotion' },
            { label: 'Investigation and fix pull requests', url: 'https://docs.opslane.com/guides/fix-prs/', description: 'When a PR opens, and ready vs draft' },
            { label: 'Environments', url: 'https://docs.opslane.com/guides/environments/', description: 'Labels, the project default, and action scope' },
            { label: 'API keys', url: 'https://docs.opslane.com/guides/api-keys/', description: 'Ingest keys, source-map keys, minting, rotation' },
            { label: 'Slack notifications', url: 'https://docs.opslane.com/guides/slack-notifications/', description: 'Webhooks, alerts, and the daily digest' },
            { label: 'Trust and security model', url: 'https://docs.opslane.com/architecture/trust/', description: 'What each external service receives' },
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
            { label: 'Connect GitHub', slug: 'guides/github-app' },
            { label: 'Source maps', slug: 'guides/source-maps' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'How issues work', slug: 'guides/issues' },
            { label: 'Friction and session recordings', slug: 'guides/friction' },
            { label: 'Investigation and fix pull requests', slug: 'guides/fix-prs' },
            { label: 'What "verified" means', slug: 'architecture/precision' },
            { label: 'Architecture overview', slug: 'architecture/overview' },
            { label: 'Life of an error', slug: 'architecture/life-of-an-error' },
          ],
        },
        {
          label: 'Configure',
          items: [
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'API keys', slug: 'guides/api-keys' },
            { label: 'Slack notifications', slug: 'guides/slack-notifications' },
          ],
        },
        {
          label: 'Trust and privacy',
          items: [
            { label: 'Trust and security model', slug: 'architecture/trust' },
            { label: 'Replay privacy and masking', slug: 'guides/replay-privacy' },
            { label: 'Source-map privacy', slug: 'guides/source-map-privacy' },
          ],
        },
      ],
    }),
  ],
});
