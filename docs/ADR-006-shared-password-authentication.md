# ADR-006: Shared Password Authentication

## Status

Accepted

## Decision

llm-chat remains a single-owner application. It authenticates browsers with one shared password and does not assign
conversations to authentication identities.

When a data directory has no password, the server generates an eight-digit numeric initial password, stores only its
scrypt hash and salt, and prints the password once. A browser submits the password to the login endpoint and receives
a random session token in a 180-day sliding `HttpOnly`, `SameSite=Strict` Cookie. The Cookie uses `Secure` only when
the request uses HTTPS.

An authenticated browser can replace the password. The server revokes every existing session and issues a replacement
session to the browser that changed it. Password recovery remains an offline CLI operation that generates a new initial
password and revokes all sessions.

Password mode accepts plain HTTP so the application works without certificates or secure-context browser features.
Plain HTTP does not provide confidentiality, server authenticity, or replay protection. Operators who require those
properties must provide HTTPS or another trusted transport layer.

## Consequences

- Safari, Chrome, Firefox, and ordinary HTTP clients can log in without WebAuthn support.
- Anyone who learns the shared password has the same application authority as the owner.
- Changing or resetting the password signs out every other browser.
- Non-local HTTP may prevent Service Worker and PWA installation even though the web application remains usable.
- The password does not provide multi-user authorization or isolate host-level tools.
