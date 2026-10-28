# Task: Role-based access control

## Objective

Enforce organization roles (owner, admin, member, viewer) on API routes.

## Technical Context

- Builds on `request.identity` from the auth plugin (`docs/contracts/identity.ts`).
- Role and permission matrix in `docs/contracts/permissions.md`.

## Scope

- `authorize(permission)` route hook in `src/api/middleware/authorize.ts`.
- Permission evaluation in `src/rbac/` (pure functions, fully unit-tested).
- Out of scope: changing endpoints themselves; propose route annotations in the PR for backend to apply.

## Files

- `src/rbac/**`
- `src/api/middleware/authorize.ts`

## Dependencies

- auth: identity on the request (must be merged, or available via the contract stub).

## Acceptance Criteria

- The permission matrix is enforced exactly as documented; every cell has a test.
- Missing identity → 401, insufficient role → 403.

## Validation

```sh
npm test -- src/rbac
```

## Deliverables

- Commits on `feat/rbac`.
