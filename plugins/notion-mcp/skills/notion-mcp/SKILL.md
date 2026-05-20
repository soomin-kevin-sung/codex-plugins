---
name: notion-mcp
description: Use when the user asks Codex to search, inspect, summarize, create, or update Notion workspace content through the Notion MCP server.
---

# Notion

Use the Notion MCP tools for Notion workspace work.

## Read workflow

1. Search with the narrowest query that can answer the user's request.
2. Fetch only the pages or objects needed for the task.
3. Summarize titles, owners, dates, status fields, and the relevant content.
4. Preserve links or page identifiers when they are needed for follow-up actions.

## Write workflow

Before changing Notion content, clearly state the intended change and confirm it with the user unless they already gave an explicit write instruction.

Write operations include:

- Creating pages
- Editing page content
- Updating task or database fields
- Resolving or replying to comments

## Safety

- Do not expose OAuth tokens, API tokens, or local Codex auth files.
- Treat Notion permissions as the authenticated user's permissions.
- Keep page edits concise and easy to review.
- Prefer markdown-style content when the tool supports it.
