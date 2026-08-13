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
            { label: 'Introduction', link: '/' },
            // Hosted quickstart (#21) goes first when it ships.
            { label: 'Self-host Opslane', slug: 'quickstart/self-host' },
            { label: 'Install the SDK', slug: 'install' },
            { label: 'React', slug: 'guides/react' },
            { label: 'Vue 3', slug: 'guides/vue' },
            { label: 'Vanilla JavaScript', slug: 'guides/vanilla' },
            { label: 'Connect GitHub', slug: 'guides/github-app' },
            { label: 'Source maps', slug: 'guides/source-maps' },
            { label: 'Upgrading source-map keys', slug: 'guides/source-maps-migration' },
          ],
        },
        {
          label: 'How Opslane works',
          items: [
            { label: 'Architecture overview', slug: 'architecture/overview' },
            { label: 'Life of an error', slug: 'architecture/life-of-an-error' },
            { label: 'What "verified" means', slug: 'architecture/precision' },
          ],
        },
        {
          label: 'Issues',
          items: [
            { label: 'How issues work', slug: 'guides/issues' },
            { label: 'Friction', slug: 'guides/friction' },
            { label: 'How sessions are analyzed', slug: 'guides/session-analysis' },
          ],
        },
        {
          label: 'Fixes',
          items: [
            { label: 'How investigation works', slug: 'guides/investigation' },
            { label: 'When Opslane opens a pull request', slug: 'guides/fix-prs' },
          ],
        },
        {
          label: 'Projects and keys',
          items: [
            { label: 'Environments', slug: 'guides/environments' },
            { label: 'API keys', slug: 'guides/api-keys' },
          ],
        },
        {
          label: 'Notifications',
          items: [
            { label: 'Slack notifications', slug: 'guides/slack-notifications' },
          ],
        },
        {
          label: 'Privacy and trust',
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
