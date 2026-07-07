# Documentation Policy

Forge must remain easy for future agents to modify from inside itself. Documentation is part of the implementation, not an afterthought.

## Mandatory doc updates

Update docs in the same change when modifying any of these:

- CLI commands or flags
- provider interfaces
- optional capabilities
- provider implementations
- task statuses or lifecycle policy
- config schema
- file layout under `.forge/`
- sync, doctor, spec, workspace, or agent behavior

## Minimum locations

- User-facing command: update `README.md` and `docs/commands.md`.
- Provider/capability: update `docs/providers.md`.
- Core concept: update `docs/architecture.md`.
- Agent workflow or conventions: update `AGENTS.md` or `docs/agent-guide.md`.

## Review checklist

Before `forge sync`:

- [ ] Does a new agent know where to start?
- [ ] Are command effects and exit behavior documented?
- [ ] Are provider boundaries explicit?
- [ ] Are tests meaningful?
- [ ] Did `npm test`, `npm run build`, and `forge doctor` pass?

## Inspired by pi

Pi documents how it can extend itself via context files, skills, extensions, prompt templates, and packages. Forge adopts the same self-description pattern: project instructions plus detailed docs for extension points. As Forge package support grows, provider packages should include docs and agent instructions alongside code.
