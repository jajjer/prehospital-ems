# Contributing

## Dev environment

**Prerequisites:** Node.js ≥ 20, pnpm ≥ 10, Docker + Docker Compose.

```sh
git clone https://github.com/openmrs/openmrs-ems-prehospital
cd openmrs-ems-prehospital
pnpm install
docker compose -f infra/openmrs/docker-compose.yml up -d
pnpm dev   # field app at http://localhost:3000
```

Default OpenMRS credentials: `admin` / `Admin123`

## Running tests

```sh
pnpm test        # all packages
pnpm typecheck   # TypeScript strict check
```

Tests in `packages/fhir-contracts/src/__tests__/e2e.test.ts` require the Docker stack to be running. They skip automatically if `localhost:8069` is unreachable.

## Code style

- TypeScript strict mode (`strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`)
- No linter config yet — follow the existing style in each file
- Every source file must carry the MPL 2.0 header (see any existing `.ts` / `.tsx` for the template)

## PR process

1. Open an issue or comment on an existing one before starting significant work.
2. Branch from `main`, name it `<type>/<short-description>` (e.g. `fix/dead-letter-retry`).
3. `pnpm typecheck && pnpm test` must pass before opening a PR.
4. Keep PRs focused — one concern per PR.
5. Reference the related issue in the PR description.

## License

All contributions are licensed under the Mozilla Public License 2.0. By submitting a pull request you agree that your contribution may be distributed under that license.
