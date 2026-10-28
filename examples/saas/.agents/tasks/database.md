# Task: Database schema and migrations

## Objective

Model the core multi-tenant data: organizations, users, memberships, roles and projects,
with migrations and a typed repository layer.

## Technical Context

- PostgreSQL 16, Drizzle ORM, migrations in `migrations/`.
- Entity list and field names are fixed in `docs/contracts/entities.md` (do not rename fields).
- Repository interfaces are declared in `docs/contracts/repositories.ts`; implement them.

## Scope

- Tables: organizations, users, memberships (user × organization × role), roles, projects.
- Repository implementations in `src/db/repositories/`.
- Seed script for local development.
- Out of scope: HTTP endpoints, authentication logic, UI.

## Files

- `src/db/**`
- `migrations/**`

## Dependencies

- None. Other agents depend on this schema: keep the contract stable and note any change in the PR.

## Acceptance Criteria

- `npm run db:migrate` applies cleanly to an empty database and is reversible.
- Every repository interface in `docs/contracts/repositories.ts` has an implementation with tests.
- Unique constraints: user email (global), membership (user, organization).
- No credentials in code; connection string comes from `DATABASE_URL`.

## Validation

```sh
npm run db:migrate && npm test -- src/db
```

## Deliverables

- Commits on `feat/database`; PR description lists any contract changes.
