# Task: Admin dashboard

## Objective

Build the admin web app for managing organization members, roles and projects.

## Technical Context

- React 19 + Vite in `apps/admin`, typed API client generated from `docs/contracts/openapi.yaml`.
- Until backend and rbac merge, run against the mock server (`npm run mock:api`).

## Scope

- Layout, navigation, sign-in screen.
- Members list with role editing (owner/admin only), projects list.
- Out of scope: any server-side code.

## Files

- `apps/admin/**`

## Dependencies

- backend: endpoints for users and projects.
- rbac: role rules (hide controls the user cannot use; the server remains the authority).

## Acceptance Criteria

- All screens work against the mock server and the real API once merged.
- Component tests for role-gated controls.

## Validation

```sh
npm --workspace apps/admin test && npm --workspace apps/admin run build
```

## Deliverables

- Commits on `feat/admin`.
