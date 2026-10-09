import { SERVER_NAME, SERVER_VERSION } from './tools.js';

/**
 * The MCP Server Card (SEP-1649) at `/.well-known/mcp/server-card.json`: what a
 * client or a registry needs before connecting. Public, read-only, no secrets.
 * `test/mcp.test.ts` checks that the tools listed here are exactly the server's.
 */
export const CARD_TOOLS: ReadonlyArray<{ name: string; title: string; description: string; scans?: true }> = [
  { name: 'list_spaces', title: 'List spaces', description: 'The spaces this connection can read, newest first, with their latest scan.' },
  { name: 'search_spaces', title: 'Search spaces', description: 'The records that best answer a question across all spaces or one, in any language.' },
  { name: 'get_space', title: 'Read a space', description: 'The current document of a space by section, with optional photo evidence.' },
  { name: 'get_space_markdown', title: 'Read a space as one page', description: 'The whole space as one Markdown page.' },
  { name: 'ask_space', title: 'Ask a space', description: 'A short answer from the records of one space, with citations, or "not documented".' },
  { name: 'list_scans', title: 'List scans of a space', description: 'The scan history of a space.' },
  { name: 'compare_scans', title: 'Compare two scans', description: 'What changed between two scans, with photo evidence of both.' },
  { name: 'get_evidence_photo', title: 'Get an evidence photo', description: 'The original video frame behind a record.' },
  { name: 'get_scan_status', title: 'Scan status', description: 'Where a scan is.' },
  { name: 'follow_scan', title: 'Follow a scan', description: 'Waits for a running scan and reports its progress.' },
  { name: 'wallet', title: 'Balance and price', description: 'The prepaid balance, the free scans left and the price of a scan.' },
  { name: 'check_frame', title: 'Check a photo', description: 'Whether a photo is usable for a scan, and which key locations it shows.', scans: true },
  { name: 'create_scan', title: 'Create a scan', description: 'Declares a scan and returns the upload instructions.', scans: true },
  { name: 'upload_frame', title: 'Upload a frame', description: 'Sends one image of a frames scan.', scans: true },
  { name: 'start_scan', title: 'Start a scan', description: 'Starts and charges a scan.', scans: true },
  { name: 'cancel_scan', title: 'Cancel a scan', description: 'Cancels a scan that has not started.', scans: true },
];

export function serverCard(origin: string): Record<string, unknown> {
  return {
    serverInfo: { name: SERVER_NAME, title: 'Space Context', version: SERVER_VERSION },
    description:
      "The user's physical spaces (homes, rentals, offices, vehicles, appliances), each filmed once and turned into structured records with photo evidence. Read-only by default; scanning only when the user allows it at sign-in.",
    websiteUrl: 'https://spacecontext.app/developers/',
    documentationUrl: 'https://spacecontext.app/developers/docs/mcp/connect/',
    repository: { url: 'https://github.com/finikoslab/spacecontext', source: 'github', subfolder: 'packages/mcp' },
    transport: { type: 'streamable-http', endpoint: `${origin}/mcp` },
    authentication: {
      required: true,
      schemes: ['oauth2'],
      metadata: `${origin}/.well-known/oauth-authorization-server`,
      protectedResource: `${origin}/.well-known/oauth-protected-resource/mcp`,
    },
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
    tools: CARD_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.scans ? `${tool.description} Only on a connection allowed to scan.` : tool.description,
    })),
    resources: [
      { uri: 'spacecontext://spaces', name: 'spaces', mimeType: 'application/json' },
      { uriTemplate: 'spacecontext://spaces/{space_id}', name: 'space', mimeType: 'text/markdown' },
    ],
    prompts: [{ name: 'check_out_report' }, { name: 'where_is' }],
  };
}
