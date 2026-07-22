# Production deployment workflow

`.github/workflows/deploy-production.yml` deploys the exact `main` revision that
passed the **Performance and responsive quality gate**. It can also be started
manually with `workflow_dispatch` for recovery operations.

The production job performs these operations in order:

1. validates every required GitHub production secret;
2. links the configured Supabase project and previews pending migrations;
3. applies only migrations not already recorded by Supabase;
4. deploys the Edge Functions present in `supabase/functions` using the JWT
   settings in `supabase/config.toml`;
5. pulls the Vercel production configuration, builds the validated revision,
   and deploys the prebuilt output with `--prod`.

Configure these secrets in the GitHub `production` environment before enabling
the workflow:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_ID`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `VERCEL_TOKEN`

The workflow fails before migrations when any credential is absent. Protecting
the `production` environment with required reviewers is optional; when enabled,
GitHub waits for approval before exposing its secrets or starting deployment.

Do not enable a second automatic Supabase or Vercel deploy integration for the
same branch unless duplicate deployments are intentional. This workflow is the
single production deployer for changes merged into `main`.
