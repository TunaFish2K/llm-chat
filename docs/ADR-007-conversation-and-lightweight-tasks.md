# ADR-007: Conversation and Lightweight Tasks

## Status

Accepted. Supersedes ADR-002.

## Decision

The product focuses on conversation and lightweight tasks. Agents use general tools to complete concrete requests such as information lookup, calculations, file processing, and batch scripts. Background tasks and interactive commands remain available under the existing permission, approval, and resource rules.

Remove the built-in Codex control panel, runtime adapter, dedicated HTTP APIs, tools, and event contracts. Remove the bundled `coding-supervisor` Skill without introducing a replacement coding supervisor. The command execution guide describes how to choose tools for the current request, with read-only operations preferred for local reading and analysis. It does not promote autonomous coding delegation or persistent service hosting as a default workflow.

## Upgrade and History

Keep the historical Codex database tables and migrations. The application no longer connects to or resumes those sessions. Removed HTTP APIs use the normal API-not-found response, and removed tools use the existing unavailable-tool behavior.

Unload the retired bundled Skill and exclude it from selectable Skills and new generation snapshots. Keep its installation row and revision files because deleting the row would cascade to historical revisions. Do not allow reloading or reinstalling that bundled source to reactivate it. Existing Agent references are inert; historical Agent and generation snapshots are not rewritten.

Historical messages, tool calls, saved presentations, and Skill revisions remain readable. User-installed Skills and the host's Codex installation and data are outside this removal. Model names containing Codex remain valid model names.

## Consequences

The task view presents general background tasks. The core application no longer maintains a second conversation and approval interface for a specific coding agent. This change does not add execution limits or replace the general Plugin, Skill, Shell, or background-task mechanisms.
