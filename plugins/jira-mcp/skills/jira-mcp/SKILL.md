---
name: jira-mcp
description: Use when the user asks Codex to search, inspect, summarize, or update Atlassian Jira issues through the Jira MCP server.
---

# Jira

Use the Jira MCP tools for Jira and Confluence work.

## Read workflow

1. Use Jira search for natural-language lookup unless the user provides explicit JQL.
2. Use JQL search when the user asks for JQL or provides an issue key.
3. Fetch only the fields needed for the task.
4. Summarize issue key, title, status, assignee, priority, and the relevant description or comments.

## Write workflow

Before changing Jira, clearly state the intended change and confirm it with the user unless they already gave an explicit write instruction.

Write operations include:

- Editing issue fields
- Transitioning issue status
- Adding or updating worklogs

## Safety

- Do not expose OAuth tokens, API tokens, or local Codex auth files.
- Treat Jira permissions as the authenticated user's permissions.
- Keep comments concise and factual.
- Prefer markdown body content unless exact Atlassian Document Format is required.
