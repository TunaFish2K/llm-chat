# Open Decisions

## Authentication And Remote Access

Status: Deferred

The current trust boundary is one machine owner using a loopback service. The directory browser, Plugin host, workspace tools, and background processes run with the service account's host permissions.

Revisit authentication and authorization before either condition becomes true:

- the service listens on a non-loopback interface;
- more than one operating-system user or application user can access the service.

The future decision must cover user identity, per-workspace access, Plugin installation authority, secret ownership, task visibility, and approval audit attribution.
