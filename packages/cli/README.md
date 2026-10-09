# spacecontext

Space Context from the terminal. Film a space once, then search it, ask it questions and hand it to your agents as a Skill.

```bash
npx spacecontext login                            # approve a code in the console; the key comes back here
npx spacecontext scan tour.mp4 --name "Seaside flat" --type apartment
npx spacecontext search "where is the fuse box?"
npx spacecontext ask spc_… "is there a hair dryer?"
npx spacecontext skill spc_… --out ~/.claude/skills/seaside-flat
```

| Command | |
| --- | --- |
| `login [--test] [--no-browser] [--key -]` / `logout` / `whoami` | Sign in (a code to approve in the console; `--key -` saves a key you have, typed without echo), forget, check |
| `wallet` | Balance, free scans left, price per scan |
| `spaces [--source app\|api]` | List your spaces |
| `space <id> [--transcript]` | Show a space; `--json` for the full document |
| `search <question…> [--space id] [--limit n]` | Search every space |
| `ask <space-id> <question…>` | A short answer with its sources |
| `skill <space-id> [--out dir] [--transcript]` | Write the space as an Agent Skill folder |
| `markdown <space-id> [--out file] [--transcript]` | The space as one Markdown page |
| `scans <space-id>` | The scan history of a space |
| `diff <space-id> --from <scan> [--to <scan>]` | What changed between two scans |
| `delete-space <space-id>` | Delete a space created through the API, with its scans |
| `scan <video\|frames-dir> (--space id \| --name …) [--format text\|json\|markdown\|skill] [--out path]` | Upload (`.mp4 .mov .m4v` up to 100 MB, or a folder of up to 120 `.jpg .png .webp` of 2 MB each), follow the analysis live, print the result in the format you want |
| `check <image\|frames-dir>` | Before a scan: which frames are usable, and which key locations (fuse box, stopcock, boiler…) they show |
| `scan-status <scan-id> [--follow]` | Where a scan is; `--follow` prints every change until it ends |
| `cancel <scan-id>` | Cancel a scan that has not started; nothing is charged |

Every command accepts `--json`, `--api-key` and `--base-url`. The key is read from `--api-key`, then `SPACECONTEXT_API_KEY`, then the file written by `login` (`~/.config/spacecontext/config.json`, readable by you only); a base URL saved by `login` is used only with the key saved with it. `login` shows a code, opens the console and receives the key there, never through the browser. To save a key you already have, `login --key -` asks for it without echoing it; `--key sc_…` works too, but leaves the key in your shell history. Exit codes: `0` success, `1` failure, `2` wrong usage.

Videos are analysed on the server: no ffmpeg needed. A test key (`sc_test_…`) runs the whole flow for free and returns the demo space.

MIT © Finikos S.r.l.
