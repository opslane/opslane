# How error-monitoring tools configure source-map upload credentials and endpoints (build-time)

- **Date:** 2026-08-04
- **Status:** research notes (primary sources only: vendor docs, plugin/CLI source on GitHub)
- **Note:** this file starts the `docs/research/` convention. The repo previously had
  `docs/design/` and `docs/plans/` but no home for primary-source research writeups;
  research notes go here as `YYYY-MM-DD-topic.md`.

Scope: BUILD-TIME upload paths only (Vite/webpack plugins and upload CLIs), not the
runtime error-reporting SDKs. For each tool: (1) default endpoint and where it is
defined, (2) self-hosted override, (3) combined vs separate credential, (4) behavior
when config is missing or upload fails, (5) any stated vendor rationale.

---

## Sentry — `@sentry/vite-plugin` + `sentry-cli`

**1. Default endpoint: `https://sentry.io`, hardcoded in the bundler-plugin core.**
In `getsentry/sentry-javascript-bundler-plugins` (tag 3.5.0),
`packages/bundler-plugin-core/src/options-mapping.ts`:

```ts
export const SENTRY_SAAS_URL = "https://sentry.io";           // line 85
url: userOptions.url ?? process.env["SENTRY_URL"] ?? SENTRY_SAAS_URL,  // line 92
```

- https://github.com/getsentry/sentry-javascript-bundler-plugins/blob/3.5.0/packages/bundler-plugin-core/src/options-mapping.ts
- Note: as of tag 5.4.0 the repo's `packages/vite-plugin/src/index.ts` is a one-line
  re-export of `@sentry/bundler-plugins/vite` (implementation moved into the
  `@sentry/bundler-plugins` package, versioned with sentry-javascript 10.x); the 3.5.0
  tree above is the classic, widely deployed implementation.

`sentry-cli` has the same default: `defaults.url` / `SENTRY_URL` — "The URL to use to
connect to Sentry. Default: `https://sentry.io/`"
(https://docs.sentry.io/cli/configuration/).

**2. Self-hosted override:** `url` plugin option or `SENTRY_URL` env var (plugin);
`defaults.url` in `.sentryclirc` or `SENTRY_URL` (CLI). Same source lines as above.

**3. Credential shape: the upload path does NOT use the DSN.** The runtime DSN
(embedding host + public key) is runtime-only. The build-time upload uses
`org` + `project` + `authToken` (+ optional `url`), from options or
`SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN`/`SENTRY_URL`
(options-mapping.ts lines 89-92, link above).

**However**, Sentry's newer *org auth tokens* (`sntrys_` prefix) are a combined
build-time credential: the token embeds a base64 JSON payload with `org`, `url`, and
`region_url`. Verified in `sentry-cli` source, `src/utils/auth_token/org_auth_token.rs`:

```rust
pub struct AuthTokenPayload {
    pub org: String,
    // URL may be missing from some old auth tokens, see getsentry/sentry#57123
    pub url: String,
}
```

- https://github.com/getsentry/sentry-cli/blob/master/src/utils/auth_token/org_auth_token.rs
- The vite plugin recognizes this: it only warns about a missing `org` when the token
  is *not* an org token — `!options.org && !options.authToken.startsWith("sntrys_")`
  (build-plugin-manager.ts lines 407, 517 at tag 3.5.0,
  https://github.com/getsentry/sentry-javascript-bundler-plugins/blob/3.5.0/packages/bundler-plugin-core/src/build-plugin-manager.ts).
- The token-embedded URL takes precedence over configured `SENTRY_URL` in practice;
  see the vendor-repo bug report "Org tokens resolve to sentry.io, ignoring EU data
  residency" (https://github.com/getsentry/sentry/issues/116550).

**4. Missing config: warn-and-skip. Upload error with config present: hard build
failure by default.** Two distinct behaviors, both in
`packages/bundler-plugin-core/src/build-plugin-manager.ts` (tag 3.5.0):

- Missing `authToken` / `org` / `project` → `logger.warn("No auth token provided.
  Will not upload source maps. Please set the `authToken` option. ...")` and the hook
  returns; the build succeeds (lines 401-419 for release creation, 512-527 for
  sourcemap upload).
- An error *during* release creation or upload → build stops. `errorHandler` option
  doc in `packages/bundler-plugin-core/src/types.ts` (lines 54-68): "When an error
  occurs during release creation or sourcemaps upload, the plugin will call this
  function. **By default, the plugin will simply throw an error, thereby stopping the
  bundling process.** If an `errorHandler` callback is provided, compilation will
  continue..."
- `telemetry` defaults to `true` (plugin error/performance data sent to Sentry;
  types.ts lines 70-78, options-mapping.ts line 97).

**5. Rationale:** RFC 0091 "CI upload tokens"
(https://github.com/getsentry/rfcs/blob/main/text/0091-ci-upload-tokens.md) is
explicit. Problem: too much config friction (org slug, project slug, manual URL) for
CI uploads, especially "Hybrid Cloud and Single Tenant" where "customers are often
required to work with CS to get source maps working." Design: embed
`{"iat": ..., "region_url": "https://eu.sentry.io/", "url": "https://sentry.io/",
"org": "myorg"}` in the token; "A token will always have a site in it and clients are
not supposed to provide an automatic fallback."

---

## PostHog — `posthog-cli` (`posthog-cli sourcemap inject|upload`)

**1. Default endpoint: `https://us.posthog.com`, hardcoded.** In
`PostHog/posthog`, `cli/src/utils/auth.rs`:

```rust
pub fn get_host(&self) -> String {
    self.host.clone().unwrap_or("https://us.posthog.com".to_string())
}
```

- https://github.com/PostHog/posthog/blob/master/cli/src/utils/auth.rs
- Docs confirm: `--host` "Defaults to https://us.posthog.com"
  (https://posthog.com/docs/cli).

**2. Self-hosted override:** `--host` flag or `POSTHOG_CLI_HOST` env var; docs call
out `https://eu.posthog.com` for EU Cloud and the same mechanism for self-hosted
instances (https://posthog.com/docs/cli).

**3. Separate credentials:** three independent values — `POSTHOG_CLI_API_KEY` (legacy
alias `POSTHOG_CLI_TOKEN`; a personal API key with error-tracking write scope),
`POSTHOG_CLI_PROJECT_ID` (legacy alias `POSTHOG_CLI_ENV_ID`), and optional
`POSTHOG_CLI_HOST` (auth.rs `try_source`, link above). The token does not embed the
host; host defaults to US cloud when unset. Not a build plugin — a separate CLI step
(there is a GitHub Action wrapper, https://github.com/PostHog/upload-source-maps).

**4. Missing config:** credential resolution requires both key and project id
(`try_source` returns `None` otherwise → `get_credentials` returns `Err`), so the CLI
command fails; since it is a standalone step, the build fails only if the pipeline
treats the CLI's non-zero exit as fatal. Exact exit codes/messages: UNVERIFIED.

**5. Rationale for default-to-cloud:** none documented. UNVERIFIED (nothing found in
docs or repo).

---

## Bugsnag — `bugsnag-source-maps`, `bugsnag-cli`, `webpack-bugsnag-plugins`

**1. Default endpoint: `https://upload.bugsnag.com`, hardcoded — with API-key-prefix
instance routing in the newer CLI.**

- `bugsnag-source-maps`: `src/uploaders/lib/EndpointUrl.ts`:
  `export const DEFAULT_UPLOAD_ORIGIN = 'https://upload.bugsnag.com'`
  (https://github.com/bugsnag/bugsnag-source-maps/blob/master/src/uploaders/lib/EndpointUrl.ts),
  used as the `endpoint` option default in `src/uploaders/BrowserUploader.ts`
  (`endpoint = DEFAULT_UPLOAD_ORIGIN`).
- `bugsnag-cli`: `pkg/endpoints/endpoints.go` defines
  `PRIMARY_UPLOAD_ENDPOINT = "https://upload.bugsnag.com"` and
  `SECONDARY_UPLOAD_ENDPOINT = "https://upload.bugsnag.smartbear.com"`, selected by
  API key prefix: `SECONDARY_API_PREFIX = "00000" // API keys starting with this
  indicate usage of the secondary instance.`
  (https://github.com/bugsnag/bugsnag-cli/blob/main/pkg/endpoints/endpoints.go).

**2. Self-hosted override:** `--endpoint` (bugsnag-source-maps): "If you are using
Bugsnag On-premise, you should use the endpoint option to set the url of your upload
server" (README, https://github.com/bugsnag/bugsnag-source-maps#bugsnag-on-premise).
`--upload-api-root-url` (bugsnag-cli): "The upload server hostname... For use in
BugSnag On-premise configurations"
(https://docs.bugsnag.com/build-integrations/bugsnag-cli/upload-js/). The webpack
plugin exposes `endpoint`, forwarded to the CLI as `uploadApiRootUrl`
(https://github.com/bugsnag/webpack-bugsnag-plugins/blob/master/source-map-uploader-plugin.js).

**3. Credential shape: separate `apiKey` + `endpoint` — but note the partial
combined-credential behavior:** the `00000` API-key prefix silently reroutes uploads
to the SmartBear-instance endpoint (endpoints.go, above). The key selects between the
two SaaS instances but cannot express an arbitrary on-prem URL.

**4. Missing config / failure:**
- Webpack plugin: missing `apiKey` throws at plugin construction —
  `throw new Error('[BugsnagSourceMapUploaderPlugin] "apiKey" is required')`
  (source-map-uploader-plugin.js `validate()`), i.e. hard build failure.
- Upload rejection: the plugin passes the rejection to webpack's async `afterEmit`
  callback (`BugsnagCLI.Upload.Js(...).then((output) => {...; callback()}, callback)`),
  which surfaces it as a compilation error; a trailing `.catch` logs errors thrown
  inside the handlers. (Same file, `apply()`.)
- `bugsnag-source-maps` validates required strings (`apiKey`, `sourceMap`,
  `bundleUrl`, ..., `endpoint`) up front and errors out
  (`src/uploaders/BrowserUploader.ts`, `validateRequiredStrings`).

**5. Rationale:** none stated for the default or the `00000` routing. UNVERIFIED.

---

## Rollbar — `rollbar-cli` (and community webpack plugin)

**1. Default endpoint: `https://api.rollbar.com/api/1/`, hardcoded with no override.**
`rollbar/rollbar-cli`, `src/common/rollbar-api.js`:

```js
this.axios = axios.create({
  baseURL: 'https://api.rollbar.com/api/1/',
  headers: { 'X-Rollbar-Access-Token': accessToken },
  ...
```

- https://github.com/rollbar/rollbar-cli/blob/master/src/common/rollbar-api.js
- The raw HTTP API is `POST https://api.rollbar.com/api/1/sourcemap`
  (https://docs.rollbar.com/reference/upload-a-js-source-map).

**2. Self-hosted override: none in the official CLI.** The README documents no
endpoint option or env var
(https://github.com/rollbar/rollbar-cli/blob/master/README.md), and the source
hardcodes the base URL. The *community* webpack plugin
`thredup/rollbar-sourcemap-webpack-plugin` does expose one: `rollbarEndpoint`
"(default: `https://api.rollbar.com/api/1/sourcemap`) ... can be used for self-hosted
Rollbar instances"
(https://github.com/thredup/rollbar-sourcemap-webpack-plugin#rollbarendpoint-string-default-httpsapirollbarcomapi1sourcemap).

**3. Separate credential:** `--access-token` (a `post_server_item` project token) plus
required `--url-prefix` and `--code-version`; the token does not embed any endpoint.

**4. Missing config:** `--access-token`, `--url-prefix`, `--code-version` are required
CLI options, so the command errors before uploading. Per-file upload errors are
collected and printed (`src/sourcemaps/uploader.js`); the CLI is a standalone step,
not a build plugin. Exact process exit code on partial failure: UNVERIFIED. In the
community webpack plugin, `ignoreErrors` "(default: `false`)" — upload errors are
added to the webpack compilation, i.e. fail the build unless `ignoreErrors: true`
(README link above).

**5. Rationale:** none found; Rollbar sells SaaS only, which is consistent with the
hardcoded endpoint. UNVERIFIED as an explicit statement.

---

## Datadog — `datadog-ci sourcemaps upload`

**1. Default endpoint: `https://sourcemap-intake.datadoghq.com/api/v2/srcmap` (US1
site default), assembled from a site constant.** In `DataDog/datadog-ci`:

- `packages/base/src/constants.ts` line 1: `export const DATADOG_SITE_US1 = 'datadoghq.com'`
  (https://github.com/DataDog/datadog-ci/blob/master/packages/base/src/constants.ts)
- `packages/base/src/helpers/api.ts`:
  `getDatadogSite = (site?) => site || getDatadogSiteFromEnv() || DATADOG_SITE_US1`
  with `getDatadogSiteFromEnv` reading `DATADOG_SITE || DD_SITE`; `getIntakeUrl`
  builds `https://${subdomain}.${site}`
  (https://github.com/DataDog/datadog-ci/blob/master/packages/base/src/helpers/api.ts)
- `packages/base/src/helpers/base-intake-url.ts`:
  `getBaseSourcemapIntakeUrl = (datadogSite?) => getIntakeUrl('sourcemap-intake',
  {overrideEnvVar: 'DATADOG_SOURCEMAP_INTAKE_URL', site: datadogSite})`
  (https://github.com/DataDog/datadog-ci/blob/master/packages/base/src/helpers/base-intake-url.ts)
- `packages/base/src/commands/sourcemaps/upload.ts` appends `'/api/v2/srcmap'`.
- Docs list the per-region intake URLs
  (https://docs.datadoghq.com/real_user_monitoring/guide/upload-javascript-source-maps/).

**2. Override:** `DATADOG_SITE` / `DD_SITE` selects the region;
`DATADOG_SOURCEMAP_INTAKE_URL` replaces the entire intake URL (for proxies). Datadog
offers no self-hosted product; the override exists for regions/proxies, not on-prem.

**3. Separate credential:** `apiKey: process.env.DATADOG_API_KEY || process.env.DD_API_KEY`
(upload.ts). The key does not embed the site — a key/site mismatch is a documented
failure mode (`DATADOG_SITE` "should match your Datadog region").

**4. Missing config: hard failure.** `getRequestBuilder()` in upload.ts:
`if (!this.config.apiKey) { throw new InvalidConfigurationError('Missing DATADOG_API_KEY
or DD_API_KEY in your environment.') }` — caught in `execute()`, exit code 1.
Individual upload failures are retried (`retries: 5`), rendered via
`renderFailedUpload`, and counted; the command continues over remaining files.
Whether a partial failure yields a non-zero final exit: UNVERIFIED from the code read.
As a standalone CLI, "build failure" is up to the CI pipeline.

**5. Rationale:** none stated beyond multi-region routing docs. UNVERIFIED.

---

## Honeybadger — `@honeybadger-io/webpack`, `@honeybadger-io/rollup-plugin` (Vite)

**1. Default endpoint: `https://api.honeybadger.io/v1/source_maps`, hardcoded.**
`honeybadger-io/honeybadger-js`, `packages/plugin-core/src/options.ts`:

```ts
export const DEFAULT_ENDPOINT = 'https://api.honeybadger.io/v1/source_maps'
export const DEFAULT_DEPLOY_ENDPOINT = 'https://api.honeybadger.io/v1/deploys'
const required = ['apiKey', 'assetsUrl']
```

- https://github.com/honeybadger-io/honeybadger-js/blob/master/packages/plugin-core/src/options.ts

**2. Override:** `endpoint` option — "(optional — default:
`https://api.honeybadger.io/v1/source_maps`) Where to upload your source maps to.
Perhaps you have a self hosted source map server you would like to upload your source
maps to instead of Honeybadger. If you are using our EU stack, this should be set to
`https://eu-api.honeybadger.io/v1/source_maps`."
(https://github.com/honeybadger-io/honeybadger-js/blob/master/packages/rollup-plugin/README.md).
The rollup plugin is the documented Vite path (add to `build.rollupOptions.plugins`,
same README).

**3. Separate credential:** `apiKey` + `endpoint` + `assetsUrl`; nothing embedded in
the key.

**4. Missing config: hard build failure at plugin construction.** `cleanOptions()`
throws `` `${field} is required` `` for missing `apiKey`/`assetsUrl` (options.ts,
link above), and both plugins call `cleanOptions` when instantiated. Upload failures:
`packages/plugin-core/src/sourcemaps.ts` throws
`Failed to upload N sourcemap file(s) to Honeybadger` when any upload rejects
(https://github.com/honeybadger-io/honeybadger-js/blob/master/packages/plugin-core/src/sourcemaps.ts);
the rollup/Vite plugin does not catch it in `writeBundle` → build fails
(https://github.com/honeybadger-io/honeybadger-js/blob/master/packages/rollup-plugin/src/index.ts);
the webpack plugin catches and pushes to `compilation.errors` unless
`ignoreErrors: true` (then `compilation.warnings` unless `silent`)
(https://github.com/honeybadger-io/honeybadger-js/blob/master/packages/webpack/src/HoneybadgerSourceMapPlugin.js).
Dev environments (`dev`/`development`/`test`) skip the upload entirely
(`developmentEnvironments`, options.ts).

**5. Rationale:** none beyond the endpoint doc text quoted above. UNVERIFIED.

---

## Synthesis

**Dominant pattern: hardcoded SaaS default endpoint + separate opaque token, with an
optional endpoint/host override for self-hosted or EU.** Sentry (`url` /
`SENTRY_URL`, default `https://sentry.io`), PostHog (`--host` / `POSTHOG_CLI_HOST`,
default `https://us.posthog.com`), Bugsnag (`endpoint` / `--upload-api-root-url`,
default `https://upload.bugsnag.com`), Honeybadger (`endpoint`, default
`https://api.honeybadger.io/v1/source_maps`), and Datadog (site env vars over
`datadoghq.com`, plus full-URL override) all fit it. Rollbar is the outlier: the
official CLI hardcodes `api.rollbar.com` with no override at all.

**Missing-config behavior splits two ways:**

- *Warn-and-skip* (Sentry): no token/org/project → warn and build successfully. This
  is deliberate — forks and CI runs without secrets still build — but it means a
  typo'd env-var name silently ships un-symbolicated builds.
- *Hard fail* (Honeybadger's `required` throw, Datadog's `InvalidConfigurationError`
  → exit 1, Bugsnag webpack's constructor throw, required CLI flags in Rollbar and
  the Bugsnag/PostHog CLIs): configuration mistakes surface at build time.

For upload *errors* (config present), everything except pre-5.x Sentry-with-
`errorHandler` and opt-in `ignoreErrors` flags fails the build by default.

**Combined credential precedent.** Sentry's runtime DSN embeds the endpoint but is
runtime-only — the build-time upload path never uses it. The build-time analog is
Sentry's org auth token (`sntrys_`): per RFC 0091 it embeds `org`, `url`, and
`region_url`, precisely so that "a token will always have a site in it and clients
are not supposed to provide an automatic fallback" — motivated by self-hosted/single-
tenant configuration pain. Bugsnag has a weaker version: the `00000` API-key prefix
reroutes uploads to the SmartBear instance, i.e. the credential selects among vendor
endpoints but cannot name an arbitrary one.

**Trade-off for a self-hosted-first product uploading customer source code.** With
the dominant pattern, the endpoint default is a *vendor* URL and auth is checked
server-side, after the client has started transmitting the multipart body: a
misconfigured or defaulted build sends source maps (customer source code) to the
wrong host before any 401 comes back. That is acceptable when the vendor host is the
overwhelmingly common destination (Sentry SaaS, Datadog); it is backwards for a
self-hosted-first product, where the "default" cloud URL is the *wrong* place for
most builds. Two safer designs, both with precedent:

1. **No default endpoint** — make the endpoint a required setting and hard-fail at
   build time when absent (Honeybadger-style `required` validation). Simple, but two
   values to wire and a copy-paste mismatch remains possible.
2. **Sentry-RFC-0091-style combined token** — embed the instance URL in the upload
   credential itself, with no fallback URL in the client. One value to configure, and
   the payload can only ever be sent where the credential says; a leaked config
   cannot silently redirect uploads to a vendor cloud because there is no vendor
   cloud constant in the client. The RFC explicitly frames endpoint-in-token as the
   fix for self-hosted configuration friction. (Caveat from Sentry's own tracker:
   make token-URL precedence rules explicit, or you get issues like
   getsentry/sentry#116550 where the embedded URL fights the env override.)
