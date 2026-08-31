# ADR-003: Agent Skills and Lazy Tool Discovery

## Status

Accepted

## Decision

The service discovers Agent Skills only from direct child directories of the current operating-system user's `~/.agents/skills` directory. Each child must contain a valid `SKILL.md` whose standard `name` matches the directory name and whose `description` is present. YAML frontmatter is parsed as YAML. The optional `compatibility` value is displayed, while standard `allowed-tools` remains instruction text and never grants tool authority.

Discovered Skills use the internal id `agents.<name>`. Their source is copied into the existing immutable, content-addressed revision store. A changed source enters `pending-reload`; an absent source enters `unloaded` for new snapshots. Historical pinned revisions remain readable. Discovery does not scan project directories or other assistant-specific configuration roots.

An Agent's tool policy has two independent decisions: whether a tool is enabled and whether it is direct. An **authorized tool** is enabled and currently available. A **direct tool** is sent to the model on the first step. A **lazy tool** is authorized but initially withheld. Tool approval remains a separate decision applied only when an exposed tool is called.

When at least one authorized tool is lazy, the generation exposes the internal `search_tools` meta-tool. It searches only that generation's authorized lazy catalog and exposes matches on later model steps. Search results do not alter Agent policy or grant authority. A call to a lazy tool before exposure fails without execution. Completed `search_tools` calls reconstruct exposure after approval resume. Loading a pinned Skill can expose that revision's custom `requiredTools`, but only when those tools are already authorized and available.

Provider adapters are unchanged. The generation runner supplies a different `tools` array for each model step while retaining the full authorized map for policy checks.

## Consequences

- Existing policies remain direct by default, including tools added after an Agent was saved.
- Large tool catalogs consume less provider context when an Agent marks selected tools lazy.
- Discovery and Skill metadata cannot bypass Agent enablement or approval policy.
- The persisted generation snapshot contains directness policy, pinned Skill revisions, and pinned Plugin revisions.
- Historical meta-tool results are part of the security boundary and are intersected with the current generation's authorized map when restored.
