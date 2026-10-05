import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

// Space Context developer documentation (docs.spacecontext.finikos.it).
// The API reference is rendered by Scalar from static/openapi.json, copied from
// ../openapi/openapi.json before every start and build (scripts/copy-openapi.mjs).

const config: Config = {
  title: 'Space Context Docs',
  tagline: 'The context layer for the physical world: API, CLI and MCP server.',
  favicon: 'img/favicon.svg',
  url: 'https://docs.spacecontext.finikos.it',
  baseUrl: '/',
  trailingSlash: false,
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  future: { v4: true },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/finikoslab/spacecontext/edit/dev/docs/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      '@scalar/docusaurus',
      {
        label: 'API reference',
        route: '/api-reference',
        showNavLink: false,
        // Pinned: the reference renderer is loaded from the CDN at this exact version.
        cdn: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.4',
        configuration: {
          url: '/openapi.json',
          servers: [{ url: 'https://api.spacecontext.finikos.it/v1', description: 'Production' }],
          authentication: { preferredSecurityScheme: 'apiKey' },
          // Only the reference: no Scalar assistant, MCP generator, toolbar or telemetry.
          agent: { disabled: true },
          mcp: { disabled: true },
          showDeveloperTools: 'never',
          telemetry: false,
          hideClientButton: true,
          documentDownloadType: 'json',
        },
      },
    ],
  ],

  themeConfig: {
    colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
    navbar: {
      title: 'Space Context',
      logo: { alt: 'Space Context', src: 'img/favicon.svg' },
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        { to: '/api-reference', label: 'API reference', position: 'left' },
        { href: 'https://spacecontext.finikos.it/developers/console', label: 'Console', position: 'right' },
        { href: 'https://github.com/finikoslab/spacecontext', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Product',
          items: [
            { label: 'Space Context', href: 'https://spacecontext.finikos.it' },
            { label: 'Developers', href: 'https://spacecontext.finikos.it/developers' },
            { label: 'Console', href: 'https://spacecontext.finikos.it/developers/console' },
          ],
        },
        {
          title: 'Build',
          items: [
            { label: 'Quickstart', to: '/quickstart' },
            { label: 'MCP server', to: '/mcp/connect' },
            { label: 'API reference', to: '/api-reference' },
          ],
        },
        {
          title: 'Legal',
          items: [
            { label: 'Terms', href: 'https://spacecontext.finikos.it/terms' },
            { label: 'Privacy', href: 'https://spacecontext.finikos.it/privacy' },
            { label: 'Support', href: 'https://spacecontext.finikos.it/support' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Finikos S.r.l. Open-source tools under the MIT license.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'python'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
