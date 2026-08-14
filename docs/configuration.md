# Configuration

Everything RouterFlip persists lives in one directory, and nothing in it is
secret except the fallback vault. This document is the reference for what each
file means, what you may safely edit by hand, and which environment variables
change RouterFlip's behaviour.

## Locations

| Path                                | Contents                                                            |
| ----------------------------------- | ------------------------------------------------------------------- |
| `~/.routerflip/config.json`         | Router profiles and preferences. No secrets.                        |
| `~/.routerflip/state.json`          | Active router, and exactly what permanent mode changed. No secrets. |
| `~/.routerflip/credentials.enc.json`| Encrypted keys. Only exists with the file backend.                  |
| `~/.routerflip/credentials.key`     | Master key for that vault, `0600`.                                  |
| `~/.routerflip/credentials.dpapi.json`| DPAPI-protected keys. Only exists on Windows.                     |
| `~/.routerflip/backups/`            | Timestamped copies taken before every write.                        |
| `~/.routerflip/routerflip.log`      | Debug log, appended under `--verbose`. Never contains a key.          |

On Windows, `~` is `%USERPROFILE%` (e.g. `C:\Users\you\.routerflip`).

Claude Code's own settings stay in its own directory — `~/.claude/settings.json`
by default. RouterFlip reads and patches that file in permanent mode and never
stores its own state there.

### Environment variables RouterFlip reads

| Variable            | Effect                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| `ROUTERFLIP_HOME`   | Relocates the directory above. Useful for testing, containers, or dotfile repos. |
| `CLAUDE_CONFIG_DIR` | Which Claude Code config directory to patch. The same variable Claude Code uses. |
| `ROUTERFLIP_LOG_FILE` | Log somewhere other than the default, or `none` to log nothing to disk. |
| `NO_COLOR`, `FORCE_COLOR`, `TERM` | Honoured for colour detection, alongside `--color`.               |

`--verbose` prints debug lines to stderr — never stdout, so piping is unaffected —
and appends the same lines to `~/.routerflip/routerflip.log` with mode `0600`,
which is what makes "run it again with `--verbose` and attach the log" a useful
thing to be asked. Without `--verbose` nothing is written to disk at all.

Point `ROUTERFLIP_LOG_FILE` at another path to move the file (its parent directory
is created if needed), or set it to `none` (also `off`, `no`, `0`, `false`) to keep
verbose output on stderr only. An explicit path also logs *without* `--verbose`, at
whatever level is in effect. Either way every line passes through the redactor
first, and `routerflip doctor` prints the active log path under `Environment`.

Two more are *reported* rather than read: `ANTHROPIC_BASE_URL` and
`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`. If they are set in your shell they
override anything written to `settings.json`, so `doctor` flags them as warnings.

## config.json

```json
{
  "version": 1,
  "activeRouter": "agentrouter",
  "routers": [
    {
      "id": "agentrouter",
      "name": "AgentRouter",
      "baseUrl": "https://api.agentrouter.example",
      "credentialRef": "routerflip-agentrouter",
      "description": "Primary gateway",
      "provider": "claude-code",
      "authEnvVar": "ANTHROPIC_API_KEY",
      "testPath": "/v1/messages",
      "metadata": {},
      "createdAt": "2026-01-05T09:12:44.001Z",
      "updatedAt": "2026-01-05T09:12:44.001Z"
    }
  ],
  "settings": {
    "credentialBackend": "auto",
    "color": "auto",
    "testPath": "/v1/messages",
    "backupRetention": 20
  }
}
```

Per-router fields:

- **`id`** — a slug derived from the name when the router is created, and stable
  afterwards. Renaming a router does not orphan its stored key.
- **`credentialRef`** — the account name under which the key is stored. This is
  the only link to the secret; it is not a secret itself.
- **`authEnvVar`** — `ANTHROPIC_API_KEY` (default) or `ANTHROPIC_AUTH_TOKEN`. Pick
  whichever your gateway expects; it also decides whether a health check sends
  `x-api-key` or `Authorization: Bearer`.
- **`testPath`** — per-router override for the health-check path.
- **`metadata`** — free-form string map for your own notes. Never put a key here;
  this file is not encrypted.

`settings` applies to everything:

- **`credentialBackend`** — `auto` (default), or force one of `keychain`,
  `secret-service`, `dpapi`, `file`. Forcing a backend that this machine cannot
  provide is an error, not a silent downgrade.
- **`color`** — `auto`, `always`, `never`.
- **`testPath`** — default health-check path for routers that do not set their own.
- **`backupRetention`** — how many backups per file to keep (1–500, default 20).

Editing this file by hand is fine. It is validated on load, and a file that fails
validation is reported rather than replaced — RouterFlip will not "repair" your
config by discarding it.

## state.json

```json
{
  "version": 1,
  "lastUsedRouterId": "agentrouter",
  "activation": {
    "routerId": "agentrouter",
    "routerName": "AgentRouter",
    "provider": "claude-code",
    "appliedAt": "2026-01-05T09:14:02.884Z",
    "targetFile": "/home/you/.claude/settings.json",
    "managedKeys": ["env.ANTHROPIC_BASE_URL", "apiKeyHelper"],
    "preexisting": { "env.ANTHROPIC_BASE_URL": "yes", "apiKeyHelper": "no" },
    "originBackup": "/home/you/.routerflip/backups/claude-settings-2026-01-05T09-14-02-880Z.json"
  }
}
```

`managedKeys` is the list of dotted paths RouterFlip owns in the provider's
settings file. `preexisting` records, once, whether each of those paths existed
*before* RouterFlip first touched the file — that answer is carried forward across
re-applies, because after the first write the answer would always be "yes".

Note what is absent: any previous *value*. Deactivation recovers original values
from `originBackup`, which means no secret and no user setting has to be duplicated
into RouterFlip's state. If that backup is deleted, `doctor` warns that automatic
restoration is no longer possible.

A corrupt `state.json` is reset rather than treated as fatal: it is machine state,
not your data.

## What permanent mode writes

RouterFlip patches the user-level `settings.json` and nothing else. It never
writes `managed-settings.json` (administrator policy, not ours to touch) or
`settings.local.json` (project scope, which would leak a gateway choice into a
repository).

### Permanent mode strategies

**`helper` (default).** Claude Code's `apiKeyHelper` is a command it runs to
obtain a key. RouterFlip writes:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "https://api.agentrouter.example" },
  "apiKeyHelper": "\"/usr/local/bin/routerflip\" credential agentrouter"
}
```

The key stays in the OS credential store and is fetched per request. This requires
`routerflip` (or `rflip`) to be resolvable on PATH; when it is not, no helper could
ever run, so RouterFlip falls back to `env` and says so in its output.

**`env`.** The key is written into the settings file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.agentrouter.example",
    "ANTHROPIC_API_KEY": "sk-…"
  }
}
```

Simple and universally supported, but the key then sits in a plaintext file that
Claude Code reads. Choose it deliberately with `--strategy env`.

Either way, a timestamped backup is written *before* the file is modified, every
unrelated key is preserved exactly, and a settings file that is not valid JSON is
refused rather than rewritten. A UTF-8 BOM — which PowerShell redirection and
several Windows editors add, and which `JSON.parse` rejects — is tolerated on
read.

## Health checks

`routerflip test` asks four questions in order: is the URL well formed, is the host
reachable, does the configured endpoint respond, and is the credential accepted.
The endpoint is `baseUrl` + `--path` or the router's `testPath` or
`settings.testPath` or, as a last resort, `/v1/messages`.

Because gateways differ, the outcomes are graded rather than binary: `404` is a
warning that the path is probably wrong (not a verdict on your key), `429` means
the key was accepted by a busy gateway, `401`/`403` is a genuine auth failure, and
`5xx` is the gateway's problem. Use `--timeout` to change the 15-second budget and
`--json` for the machine-readable form.

## Backups

Every write to `config.json` and to the provider's `settings.json` is preceded by
a copy into `~/.routerflip/backups/`, named `<label>-<timestamp>.json` so the list
sorts chronologically. Old ones are pruned to `settings.backupRetention`. Deleting
them is safe, with one exception: the earliest `claude-settings-*` backup recorded
as `originBackup` is what `deactivate` restores from.

## Uninstalling

```bash
routerflip deactivate      # put Claude Code's settings back first
npm uninstall -g routerflip
rm -rf ~/.routerflip       # profiles, state and backups
```

Keys held in an OS keychain are removed when you `routerflip delete` a router. If
you remove the directory without deactivating, Claude Code keeps using the gateway
that was written into its settings until you edit that file yourself.
