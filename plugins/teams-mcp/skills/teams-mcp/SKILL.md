---
name: teams-mcp
description: Use Microsoft Teams from Codex through the local Teams MCP plugin backed by teams-cli. Use when the user asks to search Teams chats, resolve recipients, read Teams messages, manage aliases/cache, or send/post Teams messages with dry-run confirmation.
---

# Teams MCP

Use this skill when a user asks Codex to interact with Microsoft Teams through
the `teams-mcp` plugin.

## Required safety flow

- Prefer MCP tools over shell commands.
- Use `teams_cli_install` if the binary is missing.
- Use `teams_cli_update` only when the user explicitly asks to update `teams-cli`.
- Use `teams_login` when the user is not logged in.
- Use `teams_search_chats` or `teams_resolve` before reading or sending to a name, email, title, alias, or thread id.
- If resolution is ambiguous, do not guess. Ask the user to choose a candidate or create an alias.
- Before a real write, call `teams_send_dry_run` or `teams_post_channel_dry_run` with the exact payload and confirmed thread id.
- For real writes, pass the dry-run result's exact `dryRunToken` plus the resolved `thread_id`/`confirm_thread_id` as `confirmThreadId`.
- Do not call `teams_send` or `teams_post_channel` unless the user clearly requested the write.
- Use aliases for frequently used or risky targets.

## Tool map

- Identity and setup: `teams_cli_install`, `teams_cli_update`, `teams_login`, `teams_logout`, `teams_whoami`
- Discovery: `teams_list_chats`, `teams_search_chats`, `teams_resolve`
- Read: `teams_read`
- Chat writes: `teams_send_dry_run`, then `teams_send`
- Channel writes: `teams_resolve_channel` if needed, then `teams_post_channel_dry_run` with the exact payload, then `teams_post_channel`
- Local state: `teams_alias_list`, `teams_alias_set`, `teams_alias_remove`, `teams_cache_info`, `teams_cache_refresh`, `teams_cache_clear`

## Notes

`teams-cli` uses unofficial Microsoft Teams web APIs. Keep request volume low
and treat tenant policy failures as authoritative. Message bodies are sent to
the CLI through stdin by the MCP server, so they are not exposed as command-line
arguments.
