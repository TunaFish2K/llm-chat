# ADR-007: OpenID Connect browser authentication

Status: accepted. Extends ADR-006; password login remains the default.

LLM Chat remains a single-owner application. Deployments may enable password login, OIDC login, or both. Both methods issue the same opaque application session cookie and grant access to the same data. An OIDC identity is admitted only when its exact issuer and subject appear in configuration; email addresses, domains and proxy identity headers cannot grant access.

OIDC uses provider discovery, Authorization Code, PKCE S256, state, nonce and signature verification against JWKS through `openid-client`. Transactions are stored on the server for ten minutes, bound to the browser and configured public origin, and consumed atomically before exchanging a code. The server validates issuer, audience, nonce, expiry and signature. Browser cookies contain no provider access tokens, ID tokens or client secrets.

Public origins and callback URLs are explicit configuration. Forwarded headers cannot choose an issuer or callback origin. Production origins require HTTPS; loopback HTTP is allowed for development. Only same-origin paths may be used as return destinations. Authentication callback query strings are omitted from application request logs; operators must also exclude them from proxy logs.

Application sessions preserve the existing 180-day sliding lifetime. The OIDC session records issuer, subject and client ID. Admission is checked on every authenticated request. Changing or resetting the password revokes sessions from both methods. Local logout revokes the application session. Provider logout uses the discovered standard end-session endpoint when available; providers without this endpoint require a separate portal logout. An application session is independent of a provider session, so portal logout alone does not revoke LLM Chat sessions.

SQLite schema 52 copies existing password sessions into the shared browser-session table without requiring users to log in again. The old table remains for migration provenance. Rollback requires restoring the schema-51 backup, rather than running an old binary against the new database.

The application has no Authelia-specific protocol paths or trusted-header login mode. Client authentication supports `client_secret_basic` and `client_secret_post`; secrets are loaded from a separate file. Machine credentials and conversation ownership are unchanged. A provider outage leaves password login available when enabled.
