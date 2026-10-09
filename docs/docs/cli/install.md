---
title: 'Install and sign in'
description: 'Install the spacecontext CLI and save an API key.'
---

# Install the CLI

The CLI needs **Node.js 22** or later. Run it without installing:

```bash
npx spacecontext --help
```

or install it globally:

```bash
npm install -g spacecontext
spacecontext --version
```

## Sign in

```bash
spacecontext login            # a live key
spacecontext login --test     # a test key: free, the demo space
```

The terminal shows a code and opens the [console](https://spacecontext.finikos.it/developers/console) (sign in with Apple, Google or your email if you are not yet). Type the code there, check what is asking, choose what the key may do, and approve: the terminal receives its key and saves it in `~/.config/spacecontext/config.json` (or `$XDG_CONFIG_HOME/spacecontext/`), readable by your user only. The key never passes through the browser, and the console never sees your terminal.

Approve only a code you are looking at in your own terminal: the name shown in the console is what the terminal said about itself. The code is never carried in a link for that reason. `--no-browser` only prints the link.

Already have a key? `spacecontext login --key sc_…` checks it with the API and saves it (`--key` is not echoed).

```bash
spacecontext whoami      # account, mode and scopes of the saved key
spacecontext logout      # forget it
```

## Where the key comes from

The CLI uses the first of:

1. `--api-key sc_…` on the command line;
2. the `SPACECONTEXT_API_KEY` environment variable (handy in CI);
3. the key saved by `login`.

`--base-url` and `SPACECONTEXT_BASE_URL` point the CLI at another API base. A base URL saved by `login --base-url …` is used only together with the key saved with it, so a key from the environment never goes to a URL meant for another key.

## Output for scripts

Every command accepts `--json` and prints the API's JSON on standard output; progress goes to standard error. Exit codes: `0` success, `1` the request failed, `2` wrong usage. Errors print the API's code and request id:

```text
Error [INSUFFICIENT_FUNDS]: The wallet does not cover this scan (request req_…)
Top up your wallet in the console: https://spacecontext.finikos.it/developers/console
```

Next: [the commands](commands.md).
