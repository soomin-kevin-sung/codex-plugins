# Teams MCP

Codex plugin for Microsoft Teams automation through
[`teams-cli`](https://github.com/soomin-kevin-sung/teams-cli).

The plugin exposes a local stdio MCP server. On first use, it installs the
latest Windows x86_64 `teams-cli` release from GitHub, verifies the release
asset `sha256` digest, and caches the binary under
`%LOCALAPPDATA%\Codex\teams-cli`. It does not update automatically after that.
Use `teams_cli_update` only when you explicitly want to reinstall the latest
release. Set `TEAMS_CLI_HOME` to use a different cache directory, or set
`TEAMS_MCP_TEAMS_BIN` to point at a specific `teams.exe` during development.
The MCP manifest sets `cwd` to the plugin root so `./mcp/server.js` resolves
correctly regardless of the Codex session's current working directory.

## MCP tools

- `teams_cli_install`
- `teams_cli_update`
- `teams_login`
- `teams_logout`
- `teams_whoami`
- `teams_list_chats`
- `teams_search_chats`
- `teams_resolve`
- `teams_read`
- `teams_send_dry_run`
- `teams_send`
- `teams_resolve_channel`
- `teams_post_channel_dry_run`
- `teams_post_channel`
- `teams_alias_list`
- `teams_alias_set`
- `teams_alias_remove`
- `teams_cache_info`
- `teams_cache_refresh`
- `teams_cache_clear`

Message bodies are passed through stdin instead of command-line arguments. The
actual send and channel-post tools require both `confirmThreadId` and a
short-lived `dryRunToken`; use `teams_resolve` or `teams_resolve_channel`, run
the corresponding payload dry-run with the confirmed thread id, then pass the
returned token unchanged to the final write.

## Authentication

Run `teams_login` once. The underlying CLI uses OAuth device-code login and
stores secret tokens in the OS keychain by default. Non-secret state and chat
metadata are kept by `teams-cli` in its normal app config directory.

## Safety notes

`teams-cli` uses unofficial Microsoft Teams web APIs. Those APIs can change,
may be blocked by tenant policy, and should be used with low request volume.
Do not send messages when `teams_resolve` or a dry-run reports ambiguity. For
name, email, display-name, or channel-title targets, always use the returned
thread id as `confirmThreadId` for the final write.

## Local validation

```powershell
npm test --prefix .\plugins\teams-mcp
.\scripts\validate.ps1
```

The tests do not contact Teams. They cover MCP JSON-RPC framing, tool argument
construction, installer asset selection, checksum verification, and safe stdin
handling for message bodies.
