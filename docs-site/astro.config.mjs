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
        starlightLlmsTxt(),
      ],
      sidebar: [
        {
          label: 'Get started',
          items: [
            // Hosted quickstart (#21) goes first when it ships.
            { label: 'Self-host quickstart', slug: 'quickstart/self-host' },
            { label: 'Install the SDK', slug: 'install' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'React', slug: 'guides/react' },
            { label: 'Vue 3', slug: 'guides/vue' },
            { label: 'Vanilla JavaScript', slug: 'guides/vanilla' },
            { label: 'Source maps', slug: 'guides/source-maps' },
            { label: 'Connecting GitHub', slug: 'guides/github-app' },
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'API keys', slug: 'guides/api-keys' },
            { label: 'When Opslane opens a PR', slug: 'guides/fix-prs' },
            { label: 'How investigation works', slug: 'guides/investigation' },
            { label: 'How sessions are analyzed', slug: 'guides/session-analysis' },
            { label: 'How issues work', slug: 'guides/issues' },
            { label: 'Friction', slug: 'guides/friction' },
            { label: 'Slack notifications', slug: 'guides/slack-notifications' },
            { label: 'Replay privacy and masking', slug: 'guides/replay-privacy' },
          ],
        },
        {
          label: 'How Opslane works',
          items: [
            { label: 'Architecture overview', slug: 'architecture/overview' },
            { label: 'Life of an error', slug: 'architecture/life-of-an-error' },
            { label: 'What "verified" means', slug: 'architecture/precision' },
            { label: 'Trust and security model', slug: 'architecture/trust' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'SDK options', slug: 'reference/sdk-options' },
            { label: 'HTTP routes', slug: 'reference/http-routes' },
            { label: 'Environment variables', slug: 'reference/environment-variables' },
            { label: 'Reason codes', slug: 'reference/reason-codes' },
          ],
        },
        {
          label: 'Contracts',
          collapsed: true,
          items: [
            { label: 'Reliability contract', slug: 'contracts/reliability' },
            { label: 'Session replay contract', slug: 'contracts/c4-amendments' },
            { label: 'Event API contract', slug: 'contracts/events' },
          ],
        },
      ],
    }),
  ],
});
