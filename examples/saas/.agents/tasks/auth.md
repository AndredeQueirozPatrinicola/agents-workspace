# Task: Authentication

## Objective

Implement JWT-based authentication with refresh tokens.

## Technical Context

- Passwords hashed with argon2id. Access tokens: 15 min, refresh tokens: 30 days, rotated on use.
- Signing key from `JWT_SECRET`; never commit secrets or sample keys.
- The authenticated identity shape `{ userId, organizationId }` is defined in `docs/contracts/identity.ts`;
  the rbac agent builds on it, so do not change it without noting it in the PR.

## Scope

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`.
- Fastify plugin `src/auth/plugin.ts` that verifies tokens and decorates `request.identity`.
- Out of scope: roles and permissions (rbac agent), user CRUD (backend agent).

## Files

- `src/auth/**`
- `src/api/auth/**`

## Dependencies

- database: `users` table and `UserRepository`. Use the in-memory repository until it merges.

## Acceptance Criteria

- Login, refresh rotation and logout work and are covered by tests.
- Reused refresh tokens are rejected and revoke the token family.
- No secrets are committed. Existing API contracts remain compatible.

## Validation

```sh
npm test -- src/auth
```

## Deliverables

- Commits on `feat/auth`; export the plugin for registration in `src/app.ts` (owned by backend).
