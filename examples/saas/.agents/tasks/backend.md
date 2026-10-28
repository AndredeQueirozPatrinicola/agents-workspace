# Task: REST API for users and projects

## Objective

Expose CRUD endpoints for users and projects, scoped to the caller's organization.

## Technical Context

- Fastify 5, Zod for request validation, OpenAPI spec in `docs/contracts/openapi.yaml`.
- Use the repository interfaces from `docs/contracts/repositories.ts`; do not import Drizzle directly.
- Until `feat/database` is merged, use the in-memory repositories in `src/services/testing/`.

## Scope

- `GET/POST/PATCH/DELETE /projects`, `GET/PATCH /users/:id`.
- Organization scoping on every query.
- `src/app.ts` route registration (this agent owns `src/app.ts`; other agents export plugins).
- Out of scope: login/tokens (auth agent), permission checks (rbac agent).

## Files

- `src/api/users/**`
- `src/api/projects/**`
- `src/services/**`
- `src/app.ts`

## Dependencies

- database: repository implementations. Code against the interfaces; integration happens after it merges.

## Acceptance Criteria

- Endpoints match `docs/contracts/openapi.yaml` (contract tests pass).
- Requests without an organization context are rejected with 401 (placeholder hook until auth lands).
- Unit and contract tests pass.

## Validation

```sh
npm test -- src/api src/services && npm run lint
```

## Deliverables

- Commits on `feat/backend`.
