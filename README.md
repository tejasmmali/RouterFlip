
# RouterFlip 
![NPM Downloads](https://img.shields.io/npm/dw/routerflip)

**Switch your Claude Code gateway in seconds.**

If you use more than one Anthropic-compatible gateway — AgentRouter, TabiRouter,
GoRouter, a self-hosted relay, the official API — switching between them normally
means editing `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` by hand, in the right
shell, without leaking a key into your history. RouterFlip turns that into one
command, keeps every key in your operating system's credential store, and can
undo whatever it changed.

```
❯ routerflip

  ╭──────────────────────────────────────────────────────────╮
  │  RouterFlip                Switch your gateway in seconds │
  ╰──────────────────────────────────────────────────────────╯

  ❯ ● AgentRouter                                     active
      https://api.agentrouter.example
    ○ TabiRouter
      https://tabi.example/anthropic
    ○ Local relay
      http://localhost:8787/relay

  ↑↓ Navigate  Enter Select  A Add  E Edit  D Delete  T Test  C Current  Q Quit
```

- **Two ways to switch.** *Temporary* launches Claude Code with the gateway's
  variables set for that one child process — nothing on disk changes. *Permanent*
  writes the choice into Claude Code's own `settings.json`, after a backup, and
  `routerflip deactivate` puts it back.
- **Keys live in the OS keychain.** Windows DPAPI, macOS Keychain, or the Linux
  Secret Service. `config.json` holds a reference, never a key. No key is ever
  printed, logged, or sent anywhere except the process that needs it.
- **Zero runtime dependencies.** One `npm install -g`, no native build step, and
  startup fast enough that `routerflip claude` feels like typing `claude`.

## Contents

- [Install](#install) · [First run](#first-run) · [Everyday use](#everyday-use)
- [Temporary vs permanent](#temporary-vs-permanent) · [Commands](#commands)
- [Where things are stored](#where-things-are-stored) · [Security model](#security-model)
- [Troubleshooting](#troubleshooting) · [Supported platforms](#supported-platforms)
- Reference: [docs/configuration.md](docs/configuration.md) · [docs/security.md](docs/security.md)

## Install

```bash
npm install -g routerflip
```

Then just run it:

```bash
routerflip
```

That gives you two commands, `routerflip` and the shorter `rflip`. Node.js 20.11
or newer is required; nothing else is.

From a clone:

```bash
git clone https://github.com/tejasmmali/RouterFlip.git
cd RouterFlip
npm install          # devDependencies only — TypeScript and @types/node
npm run check        # typecheck + tests
npm link             # puts routerflip on your PATH
```

RouterFlip does **not** install Claude Code. If `claude` is missing it tells you
so and points at <https://claude.com/claude-code>; everything except launching
Claude Code still works without it.

## First run

```bash
routerflip add
```

The form asks for a name, the gateway's base URL, the API key (typed invisibly),
and an optional description. The key goes straight to your OS credential store.

Non-interactively — note the key arriving on stdin, so it never appears in your
shell history or in `ps` output:

```bash
printf %s "$MY_GATEWAY_KEY" | routerflip add \
  --name AgentRouter \
  --url https://api.agentrouter.example \
  --key-stdin
```

URLs are normalized: a bare `api.example.com` becomes `https://api.example.com`,
trailing slashes and query strings are dropped, and a pasted `/v1/messages` suffix
is stripped, because Claude Code appends its own path.

Then check everything is wired up:

```bash
routerflip doctor
routerflip test AgentRouter
```

## Everyday use

```bash
routerflip                       # the dashboard: arrows to move, Enter to pick
routerflip use AgentRouter -t    # one session on that gateway, nothing persisted
routerflip use AgentRouter -p    # make it the default for Claude Code
routerflip claude --resume       # run Claude Code through the current router
routerflip list                  # every router, active one marked
routerflip current               # what is selected right now
routerflip test --all            # four-step health check per gateway
routerflip deactivate            # undo permanent mode
```

Anything after `--` (or after the first flag RouterFlip does not recognise) is
forwarded to Claude Code untouched:

```bash
routerflip claude -- -p "explain this repo" --dangerously-skip-permissions
```

## Temporary vs permanent

|                          | `--temporary` (`-t`)                  | `--permanent` (`-p`)                          |
| ------------------------ | ------------------------------------- | --------------------------------------------- |
| What changes             | the child process's environment only  | `~/.claude/settings.json`                     |
| Files written            | none                                  | the settings file, plus a timestamped backup  |
| Your shell afterwards    | untouched                             | untouched                                     |
| Lasts for                | that one Claude Code session          | until you switch or run `deactivate`          |
| Confirmation             | none needed                           | asked before anything is written              |

**Temporary** spawns `claude` with `ANTHROPIC_BASE_URL` and your auth variable
set, inherits stdin/stdout/stderr so it behaves exactly like running `claude`
yourself, and exits with the child's own exit code. While Claude Code is running
RouterFlip stops reading the keyboard entirely and stops reacting to Ctrl+C — the
terminal already delivers it to the child, so the child is the only thing that
sees it. The competing auth variable (`ANTHROPIC_AUTH_TOKEN` if your
router uses `ANTHROPIC_API_KEY`, and vice versa) is removed from the child
environment so a stale value in your shell cannot quietly win.

**Permanent** patches exactly two things in Claude Code's user settings —
`env.ANTHROPIC_BASE_URL` plus either `env.<auth variable>` or `apiKeyHelper` — and
leaves every other key in that file byte-for-byte alone. It records what it
changed, and whether each key existed beforehand, in
`~/.routerflip/state.json`. `routerflip deactivate` restores prior values from the
first backup and deletes only the keys RouterFlip itself added.

By default the key is not written into the settings file at all: RouterFlip writes
an `apiKeyHelper` command that fetches it from the credential store on demand. If
`routerflip` is not resolvable on PATH — no helper could run — it falls back to
writing the key into the `env` block and tells you it did. Force either with
`--strategy helper` or `--strategy env`; see
[docs/configuration.md](docs/configuration.md#permanent-mode-strategies).

## Commands

| Command                    | What it does                                                |
| -------------------------- | ----------------------------------------------------------- |
| *(none)*                   | Open the interactive dashboard.                             |
| `add`                      | Add a router profile.                                       |
| `list`                     | List every configured router.                               |
| `use [name]`               | Use a router temporarily or permanently.                    |
| `claude [args…]`           | Run Claude Code through the current router.                 |
| `current`                  | Show the selected router.                                   |
| `status`                   | Routers, activation and relevant environment.               |
| `test [name]`              | Check URL, network, endpoint and auth.                      |
| `edit [name]`              | Change a name, URL, key or description.                     |
| `delete [name]`            | Delete a router and its stored key (asks first).            |
| `deactivate`               | Undo permanent mode and restore settings.                   |
| `doctor`                   | Diagnose configuration and environment.                     |
| `completion [--shell]`     | Print a completion script for bash, zsh, fish or PowerShell. |
| `version` / `help`         | Version / this list, in more detail.                        |

Useful flags: `-r/--router`, `-t/--temporary`, `-p/--permanent`,
`--strategy env|helper`, `--key-stdin`, `--auth-env`, `--path`, `--timeout`,
`--all`, `-y/--yes`, `-j/--json`, `-v/--verbose`, `--quiet`,
`--color auto|always|never`. `routerflip help` lists them all with examples.

Every command that prints a report also accepts `--json`, which is what you want
in scripts: exit code 0 means success, 1 means a real failure, 2 means the command
line itself was wrong.

Shell completion, so `routerflip use <TAB>` suggests your router names:

```bash
routerflip completion --shell bash >> ~/.bashrc          # or zsh, fish
routerflip completion --shell powershell >> $PROFILE     # Windows
```

## Where things are stored

```
~/.routerflip/
├── config.json           router profiles — no secrets, only a credentialRef
├── state.json            what is active, and what permanent mode changed
├── credentials.enc.json  encrypted keys (fallback backend only)
├── credentials.key       the file backend's master key, 0600
├── credentials.dpapi.json  DPAPI-protected keys (Windows only)
├── routerflip.log        redacted debug log, written only under --verbose
└── backups/              timestamped copies of every file before it was changed
```

Claude Code's own configuration stays where Claude Code puts it — RouterFlip never
mixes the two. Set `ROUTERFLIP_HOME` to relocate RouterFlip's directory, and
`CLAUDE_CONFIG_DIR` to point at a different Claude Code config directory (the same
variable Claude Code itself honours). Full details in
[docs/configuration.md](docs/configuration.md).

## Security model

RouterFlip is local-first. It has no server, no accounts, and **no analytics or
telemetry of any kind**. The only outbound request it ever makes is the health
check you ask for with `routerflip test`, sent to your own gateway.

- Keys are stored by the OS: DPAPI on Windows, Keychain on macOS, Secret Service
  on Linux. Where none exists, an AES-256-GCM file with `0600` permissions and a
  separate master key is used, and `doctor` tells you that is what happened.
- `config.json` contains a `credentialRef` and nothing secret. Committing it, or
  syncing it to a cloud folder, leaks no credential.
- Keys are always masked when displayed (`••••••••••••cdef`), at a fixed width so
  the mask cannot reveal the length. Every printed line, log line and error
  message passes through a redactor first, including gateway responses that echo a
  key back.
- A key reaches exactly two destinations: the environment of the Claude Code
  process you launched, and the `x-api-key`/`Authorization` header of a health
  check you asked for.

The full threat model, including what the file fallback does *not* protect against,
is in [docs/security.md](docs/security.md).

## Troubleshooting

**`routerflip` opens help instead of the dashboard.** The dashboard needs a real
terminal. When stdin is not a TTY (a pipe, CI, some editor terminals) RouterFlip
prints help rather than reading keystrokes that will never come.

**Claude Code ignores the gateway I picked permanently.** A variable set in your
shell outranks `settings.json`. `routerflip doctor` flags `ANTHROPIC_BASE_URL` and
auth variables it finds in your environment; unset them, or use `-t`, which sets
them explicitly for the child.

**`Claude Code was not found on your PATH`.** Install it from
<https://claude.com/claude-code>. RouterFlip resolves the executable the way your
shell does (including `PATHEXT` and `.cmd` shims on Windows) and prints the path it
found in `doctor`.

**`test` says the endpoint responded with 404.** Your gateway uses a different
health-check path. Set one per router with `routerflip edit <name>` (or globally
via `settings.testPath` in `config.json`); nothing here assumes a fixed API
surface.

**A key stopped working after switching machines.** Credential stores are per
machine and per user; keys are not synced. Re-enter it with
`routerflip edit <name>`.

**Stray characters in Claude Code's prompt, or a dead keyboard.** Two processes
reading one terminal split escape sequences between them, so fragments of the
reports Claude Code enables (focus, mouse) end up typed into its own input box.
RouterFlip hands stdin over completely for the lifetime of the child and leaves
Ctrl+C to it, rather than forwarding a signal the terminal has already
delivered — which on Windows terminated the `.cmd` shim and orphaned Claude Code
onto a console the shell was about to start reading. If you see this on a current
version, `routerflip claude --verbose` and an issue would be welcome.

**Something is badly wrong.** `routerflip doctor --verbose` is safe to run and safe
to paste into an issue: it reports presence, never values. `--verbose` also appends
the same redacted lines to `~/.routerflip/routerflip.log`, so you can attach the log
rather than re-narrate the failure. Nothing is logged to disk without it; set
`ROUTERFLIP_LOG_FILE=none` to keep it that way even under `--verbose`.

## Supported platforms

Windows 10/11 (PowerShell, cmd, Git Bash), macOS 12+, and Linux (glibc or musl),
on Node.js 20.11+. Windows quirks are handled rather than documented away: `.cmd`
shims are launched through the interpreter with verbatim quoting, environment
variable names are treated case-insensitively, keyboard signals are left to the
process that owns the console instead of being turned into a `TerminateProcess`
that would orphan the shim's child, and no shell syntax such as
`FOO=bar command` is ever constructed internally — the child environment is built
with native process APIs on every platform.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test, no network and no real keys required
npm run check        # both
npm start -- doctor  # run from source
```

The suite mocks the network and Claude Code's process execution, so it never needs
a real API key and never touches your real configuration: both roots are
redirected into a temp directory per test.

## License

MIT — see [LICENSE](LICENSE).




