# Security

Space Context handles the inside of people's homes and workplaces, including
things said aloud on video. We take reports seriously and answer quickly.

## Reporting a vulnerability

Email **support@finikos.it** with "Security" in the subject, what you found,
how to reproduce it and what it could expose. Please do not open a public issue for a vulnerability,
and do not test against other people's spaces or accounts: a test key
(`sc_test_…`) gives you a complete demo space to work with for free.

We acknowledge reports within two working days and keep you informed until the
fix is deployed. We do not pursue researchers who report in good faith and
stay within these rules.

## Scope

- This repository: the SDK, the CLI and the MCP server.
- The API at `api.spacecontext.finikos.it`, the console and the website.

The analysis pipeline runs server-side and is not in this repository; findings
about it are in scope through the API.

## What to know when integrating

- API keys are shown once and stored hashed. A key without `spaces:sensitive`
  never receives passwords, codes or the narration, on any endpoint.
- Text captured in a space (labels, signs, speech) is treated as data: sentences
  that read as instructions to an AI are withheld before any model or agent
  sees them.
- The MCP server holds the key of a grant; the agent never sees it, and the
  user revokes it from the console.
- The CLI's sign-in code is typed by the person in the console and never
  carried in a link; approve only a code shown in your own terminal.
