import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    'setup',
    'quickstart',
    'concepts',
    {
      type: 'category',
      label: 'Account',
      collapsed: false,
      items: ['account/console-and-login', 'account/api-keys', 'account/billing', 'account/agent-payments'],
    },
    {
      type: 'category',
      label: 'MCP server',
      collapsed: false,
      items: ['mcp/connect', 'mcp/tools'],
    },
    {
      type: 'category',
      label: 'CLI',
      collapsed: false,
      items: ['cli/install', 'cli/commands', 'cli/scanning'],
    },
    {
      type: 'category',
      label: 'API',
      items: ['api/overview', 'api/scans', 'api/search-and-ask', 'api/skills-and-diff', 'api/webhooks', 'api/space-document', 'api/errors', { type: 'link', label: 'API reference', href: '/api-reference' }],
    },
    'sdk/typescript',
    {
      type: 'category',
      label: 'Guides',
      items: ['guides/claude-code-skill', 'guides/check-in-check-out', 'guides/guided-capture', 'guides/verified-evidence'],
    },
    'security-and-privacy',
    'limits',
  ],
};

export default sidebars;
