# Security model

RouterFlip handles gateway API keys, so its job is to move a secret from your
keyboard to exactly one process and to lose track of it everywhere else. This
document states what it protects against, what it does not, and how to verify
each claim yourself.

## Shape of the thing

- **No server, no account, no telemetry.** RouterFlip makes exactly one kind of
  outbound request: the health check you ask for with `routerflip test`, sent to
  the base URL you configured. Nothing is reported anywhere, not even anonymously,
  not even on error. There is no opt-out because there is nothing to opt out of.
- **No runtime dependencies.** `package.json` has an empty `dependencies` block.
  The supply chain for a global install is Node.js and this package; there is no
  transitive tree to audit and no post-install script.
- **Local-first.** Every file RouterFlip writes is under `~/.routerflip` (or
  `ROUTERFLIP_HOME`) and the provider settings file it patches on request.

## Where a key lives

A key is written to the operating system's own credential store:

| Platform | Backend                    | Mechanism                                                    |
| -------- | -------------------------- | ------------------------------------------------------------ |
| Windows  | DPAPI (user scope)         | `ConvertFrom-SecureString`; blobs in `credentials.dpapi.json` |
| macOS    | Keychain                   | `/usr/bin/security` generic passwords in the login keychain   |
| Linux    | Secret Service (libsecret) | `secret-tool` (GNOME Keyring, KWallet, KeePassXC, …)          |
| Fallback | Encrypted file             | AES-256-GCM in `credentials.enc.json`                        |

On Windows the ciphertext sits in a file RouterFlip owns, but the key that decrypts
it is held by Windows and derived from your logon credentials: the blob is useless
to another account and useless if copied to another machine. On macOS and Linux the
secret itself lives in the OS store and RouterFlip keeps nothing.

In every backend the plaintext reaches the helper process over **stdin**, never as
a command-line argument — so it cannot be read out of the process table, and does
not land in PowerShell or shell history.

`config.json` stores only a `credentialRef` — the account name the key sits under.
That file is safe to commit, sync to a cloud folder, or paste into an issue.

Backend selection is automatic but never silently downgraded: if you pin
`credentialBackend` in `config.json` to a backend this machine cannot provide,
that is an error. `routerflip doctor` always names the backend actually in use,
and warns when it is the file fallback.

### What the file fallback does and does not protect

It is used only when no OS store is reachable — a headless Linux box with no
keyring daemon, for instance. It gives you:

- AES-256-GCM ciphertext at rest, in `credentials.enc.json`.
- A separate 32-byte master key in `credentials.key`, so copying the vault alone
  is not enough.
- A per-reference subkey derived with HKDF, so the same key stored under two
  routers produces unrelated ciphertext.
- Authenticated encryption: an edited entry fails to decrypt loudly instead of
  returning garbage.
- `0600` on both files and `0700` on the directory (POSIX; on Windows the files
  inherit the user-profile ACL).

It does **not** protect against anything that can already read your files as you:
the master key sits next to the vault, so any process running as your user, any
backup that captures your home directory, and anyone with root can recover the
plaintext. It is obfuscation-plus-integrity for a machine with no keyring — not a
substitute for one. That is why `doctor` reports it as a warning rather than a
pass.

## Where a key goes

A decrypted key reaches exactly two destinations, both of which you asked for:

1. **The environment of the Claude Code process you launched** (`routerflip use -t`
   / `routerflip claude`). The child's environment is built with Node's native
   process APIs — RouterFlip never constructs a shell command line such as
   `FOO=bar claude`, on any platform, so a key is never subject to shell quoting,
   never visible in a shell history, and never in a command line another user
   could read.
2. **The `x-api-key` or `Authorization: Bearer` header of a health check** you ran
   with `routerflip test`. The key is never placed in a URL, where it would land
   in proxy and server logs.

Permanent mode's default strategy adds no third destination: it writes an
`apiKeyHelper` command, and Claude Code invokes `routerflip credential <id>` to
fetch the key per request, so the secret stays in the OS store. `--strategy env`
does add one — the plaintext `settings.json` that Claude Code reads — which is why
it is opt-in, announced when used as a PATH fallback, and documented in
[configuration.md](configuration.md#permanent-mode-strategies).

`routerflip credential` is the one command that prints a raw key, because its
output is consumed by Claude Code rather than read by a person. It is not part of
any interactive flow.

## Never displayed, never logged

- Masking is **fixed width**: twelve bullets, plus the last four characters only
  when the secret is at least twelve characters long. The mask therefore reveals
  neither the key nor its length, and a short key reveals nothing at all.
- Everything printed passes through a redactor that also catches things that merely
  *look* like credentials — `sk-…` tokens, `Bearer …` headers, JWT-shaped strings —
  so a leak needs two independent bugs, not one.
- **Gateway responses are redacted too.** Some gateways echo the key you sent back
  in an error body; that body is truncated to its first line and scrubbed before it
  is shown or logged.
- **The debug log is opt-in, redacted, and `0600`.** Nothing is written to disk
  unless you pass `--verbose`, which appends the same redacted lines it prints to
  stderr to `~/.routerflip/routerflip.log`. `ROUTERFLIP_LOG_FILE` moves it, and
  `ROUTERFLIP_LOG_FILE=none` switches disk logging off entirely. Structured debug
  objects have their sensitive-looking fields masked by key *name* as well as by
  value, so a log is safe to attach to a bug report — `routerflip doctor --verbose`
  reports presence, never values. The log is yours to delete at any time.
- Errors carry a message and a hint, not a payload. No RouterFlip error path
  interpolates a key, and the tests assert that on the paths where one is in scope.

## What it does not defend against

Stated plainly, so the boundary is not mistaken for an oversight:

- **A compromised user account.** Anything running as you can ask the OS keychain
  for the key, or read the fallback vault and its master key. RouterFlip raises the
  cost of a casual leak (a synced dotfile, a screenshot, a pasted log); it is not a
  sandbox.
- **A malicious gateway.** If you point a router at a host you do not trust and run
  Claude Code through it, you have handed that host your key and your prompts.
  RouterFlip normalizes and validates the URL and warns about plain `http://`, but
  it cannot vet the operator.
- **Other software's copies.** Once `--strategy env` has written a key into
  `settings.json`, any process that can read that file has the key, and RouterFlip
  cannot recall it. `routerflip deactivate` removes the key it added.
- **Shell environment precedence.** `ANTHROPIC_BASE_URL` or an auth variable
  exported in your shell outranks `settings.json`, so a stale export can silently
  send traffic to the wrong gateway. `doctor` flags any it finds, masked.
- **Physical access, keyloggers, and malicious npm packages installed alongside.**
  Out of scope.

## Verifying the claims

```bash
npm run check                       # typecheck + the full test suite
routerflip doctor --verbose         # backend in use, and no values anywhere
cat ~/.routerflip/config.json       # a credentialRef, no key
cat ~/.routerflip/credentials.enc.json   # ciphertext, if the fallback is in use
```

The suite mocks the network and process spawning, so it needs no real key and
never touches your real configuration — both roots are redirected into a temp
directory per test. Among other things it asserts that the vault contains no
plaintext key, that a tampered entry is refused, that a health-check report
containing an echoed key serializes without it, that `doctor` masks real shell
variables, and that permanent mode preserves every unrelated setting and restores
the originals on deactivate.

## Reporting a problem

If you find a way to make RouterFlip reveal, log, or transmit a key, please open
an issue with the reproduction steps and no real key in it.
