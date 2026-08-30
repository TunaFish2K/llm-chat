# ADR-001: Isolated Tool Plugin Registry

## Status

Accepted

## Decision

Built-in tools, MCP tools, and external ESM tools enter one server-side registry. External tools use the canonical name `plugin__<plugin-id>__<local-name>`.

The service copies an installed Plugin into a content-addressed managed revision. A Plugin with production dependencies must include `pnpm-lock.yaml`; installation runs a frozen production install. The main service validates the manifest and tool schemas before activation.

Each Plugin Revision runs in a separate Node.js child process. The process receives the Plugin's configuration and secret values; management APIs only return redacted secret metadata. A crash triggers one restart attempt. A second failure isolates the Plugin and reports an error. This process boundary protects service availability; it is not an operating-system security sandbox. Plugin code has the service account's host permissions.

A generation pins Plugin Revisions in its generation snapshot. Reload activates a revision for new generations. Existing generations keep their prior child process. MCP is an explicit exception: neither its remote behavior nor its local tool metadata is revisioned by this service.

## Consequences

- Plugin crashes do not directly crash the chat service.
- Plugin authors can add model tools without changing Fastify routes, database migrations, or frontend code.
- Operators must treat installed Plugin code as trusted local code.
- Old revision processes and files remain available while snapshots can reference them.
