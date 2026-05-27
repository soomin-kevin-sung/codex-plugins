---
name: teams-mcp
description: Use Microsoft Teams from Codex through the local Teams MCP plugin backed by teams-cli. Use when the user asks to check Teams login/auth status, login/logout, search/list/resolve Teams chats, read Teams messages, send chat messages with dry-run confirmation, post Teams channel messages, manage aliases/cache, or install/update teams-cli.
---

# Teams MCP

Use this skill when a user asks Codex to interact with Microsoft Teams through the `teams-mcp` plugin.

## Core Rules

- Prefer MCP tools over shell commands.
- If a needed `teams_*` MCP tool is not visible in the active tool list, use tool discovery for that exact tool name before falling back to shell commands.
- Use `teams_cli_install` if the binary is missing.
- Use `teams_cli_update` only when the user explicitly asks to update `teams-cli`.
- Use `teams_login` when the user asks to log in, or when a Teams task cannot continue because a Teams MCP tool returned `not_logged_in`.
- Keep request volume low; `teams-cli` uses unofficial Microsoft Teams web APIs.
- Treat tenant policy, auth, and permission failures as authoritative.
- Do not call write tools unless the user clearly requested a send or post.

## Auth And Setup

- For login-status or auth-status questions such as "am I logged in?", "check Teams auth", or "is Teams connected?", call `teams_whoami` exactly once as the first and only Teams MCP status check.
- Do not use `teams_alias_list`, `teams_cache_info`, `teams_list_chats`, `teams_search_chats`, or shell commands to infer Teams login status.
- If `teams_whoami` returns `not_logged_in`, report that the user is not logged in and offer `teams_login`.
- If the user asks to log out, call `teams_logout`; note that it removes local Teams CLI tokens, state, and cached chat metadata.

## Discovery And Reading

- For "list recent chats", call `teams_list_chats`.
- For chat search by title, member metadata, email, or thread id, call `teams_search_chats`.
- Before reading from a name, email, display name, chat title, alias, or raw thread id, call `teams_resolve` to confirm the target.
- If `teams_resolve` or search returns ambiguous candidates, ask the user to choose; do not guess.
- Use the resolved target or confirmed thread id with `teams_read`.
- Use RFC3339 timestamps for `since` and `before` when filtering reads by time.

## Chat Sends

- For a chat message send request, first call `teams_resolve` for the target.
- Use the resolved `thread_id` or `confirm_thread_id` value as `confirmThreadId`.
- Draft the exact Markdown message body before dry-run.
- Call `teams_send_dry_run` with the exact `target`, `message`, and resolved `confirmThreadId`.
- If the dry-run succeeds and the user clearly requested the send, call `teams_send` with the exact same `target`, `message`, `confirmThreadId`, and returned `dryRunToken`.
- If the user asks only to draft or prepare a message, do not call `teams_send_dry_run` or `teams_send`.

## Channel Posts

- For a channel post request, first call `teams_resolve_channel`.
- Use the resolved `thread_id` or `confirm_thread_id` value as `confirmThreadId`.
- Call `teams_post_channel_dry_run` with the exact payload and resolved `confirmThreadId`.
- If the dry-run succeeds and the user clearly requested the post, call `teams_post_channel` with the exact same `channel`, `message`, `confirmThreadId`, and returned `dryRunToken`.
- Use `cardJsonPath` only for channel dry-run validation; final `teams_post_channel` sends Markdown `message`.
- If channel resolution is ambiguous, ask the user to choose; do not guess.

## Aliases And Cache

- Use aliases for frequently used or risky targets when the user asks to create or manage them.
- Use `teams_alias_list`, `teams_alias_set`, and `teams_alias_remove` only for alias tasks.
- Use `teams_cache_info`, `teams_cache_refresh`, and `teams_cache_clear` only for explicit cache tasks or when chat discovery appears stale.
- Never use alias or cache tools as Teams login-status checks.

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
