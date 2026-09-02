# Shared JavaScript sandbox image

Build a new immutable image for each environment that runs worker jobs:

```bash
E2B_API_KEY=... pnpm --filter @opslane/worker exec tsx e2b-javascript/build.ts
```

Set `OPSLANE_E2B_JAVASCRIPT_TEMPLATE` to the returned image name. Then boot it
and verify `node --version` reports Node 22 or newer and
`free -m | awk '/Mem:/{print $2}'` reports more than 1024 MB.
On the default `e2b` backend, the worker refuses to start when `E2B_API_KEY` is
set without `OPSLANE_E2B_JAVASCRIPT_TEMPLATE`.

No image was built while implementing this change because this workspace had no
`E2B_API_KEY`. Record each production build below before deploying it.

| Date | Environment | Name | Template ID | Build ID |
| --- | --- | --- | --- | --- |
| _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
