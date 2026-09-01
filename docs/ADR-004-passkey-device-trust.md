# ADR-004: Passkey Device Trust (Superseded)

## Status

Superseded by ADR-006

This document records the previous authentication design. It is not implemented by the current service.

## Decision

llm-chat remains a single-owner application. It authenticates browsers with WebAuthn Passkeys and does not assign conversations to authentication identities.

The first trusted browser opens a short-lived bootstrap URL printed as a QR code in the server terminal. A new browser creates its own Passkey before approval. It then displays a second short-lived QR code. Any trusted Passkey can sign the approval challenge. The target tab redeems the approved credential with a separate, memory-only secret.

Bootstrap, registration, login, and approval challenges are verified on the server. Approval challenges bind the protocol version, request ID, target credential ID, target public key, expiry, and fresh randomness. QR secrets and target-tab secrets are independently random and stored only as hashes. QR secrets use the URL fragment and are removed from the address bar after parsing.

After WebAuthn succeeds, the server issues a random session token in a 180-day sliding `HttpOnly`, `SameSite=Strict` Cookie. HTTPS deployments use the `__Host-` cookie prefix. Normal API calls do not require a signature. Revoking a Passkey revokes its sessions, but it does not revoke devices that it previously approved.

Remote WebAuthn requires an explicit HTTPS public URL. Plain HTTP is accepted only at `localhost`. IP addresses and user agents are displayed during approval but do not participate in trust decisions. The design does not use manual codes, browser fingerprints, IP binding, or client-generated verification algorithms.

The PWA caches only the versioned application shell. API calls, authentication, messages, and event streams are network-only. Service worker updates wait for user confirmation and do not force a reload during generation.

## Consequences

- A synced Passkey can log in on another browser without a new device approval.
- Closing or reloading a target tab cancels its in-memory redemption capability.
- Losing every trusted Passkey requires a new bootstrap QR from the server terminal.
- Device records represent WebAuthn credentials, not guaranteed physical hardware identities.
- This decision does not provide user-level authorization or isolate host-level tools.
