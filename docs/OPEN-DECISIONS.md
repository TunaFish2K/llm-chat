# Open Decisions

## Multi-user Authorization

Status: Deferred

ADR-006 defines one shared application password. It does not create separate application users. The directory browser, Plugin host, workspace tools, and background processes still run with the service account's host permissions.

Revisit authorization before either condition becomes true:

- more than one operating-system user or application user can access the service.

The future decision must cover user identity, per-workspace access, Plugin installation authority, secret ownership, task visibility, and approval audit attribution.
