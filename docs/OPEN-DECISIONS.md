# Open Decisions

## Multi-user Authorization

Status: Deferred

ADR-006 defines one shared application password. It does not create separate application users. The directory browser, Plugin host, workspace tools, and background processes still run with the service account's host permissions.

Revisit authorization before either condition becomes true:

- more than one operating-system user or application user can access the service.

The future decision must cover user identity, per-workspace access, Plugin installation authority, secret ownership, task visibility, and approval audit attribution.

## Advanced Image Editing

Status: Deferred

ADR-010 limits the independent image workspace to text-to-image and reference-image editing. Variation, inpainting, masks, local brush selection, video generation, and raw provider options remain deferred.

Revisit this decision only after at least one configured image protocol exposes a stable capability contract for the requested operation. The future decision must cover capability discovery, mask asset ownership, editor state persistence, output/version semantics, cancellation, and provider-specific validation without leaking raw options into other models.
