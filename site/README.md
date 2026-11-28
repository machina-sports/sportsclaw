# Personal homepage and developer-site relocation plan

**Goal:** Serve the approved personal-agent page at `/`, an informational creators page at `/creators/` and the existing developer site at `/opensource/` from one static site image.

**Architecture:** nginx serves the B2C HTML and assets directly. VitePress builds the developer site with `/opensource/` as its base. The site does not proxy the hosted application, billing endpoints or relay.

**Stack:** Existing HTML/CSS/JavaScript, VitePress, nginx, Docker and node:test. No new framework, package or service.

## Scope and sequence

1. Add `test/site-routing.test.mjs` using the repository's node:test framework. Run it before changing the migration contract and record the failing cases. Cover the static image, canonical paths, asset references, safe legacy redirects and preserved installer. Provide optional loopback-only HTTP assertions for the built image.
2. Add the approved B2C page to `site/landing/index.html`, with only its required fonts, licenses, wordmarks and provenance under `site/landing/assets/`. Preserve approved design and copy. Change its developer links to `/opensource/`. The static creators page lives at `site/landing/creators/index.html` and reuses the same fonts by absolute `/assets/` paths.
3. Update `docs/.vitepress/config.mts` and custom theme links for `/opensource/`. Preserve the current developer homepage, terminal artwork, docs navigation, theme and motion. Keep reveal content visible if the observer cannot attach. Update generated `llms.txt` and copied agent instructions.
4. Update `site/Dockerfile` and `site/nginx.conf`: copy the B2C files to the web root, place the compiled developer site below `/opensource/`, and remove the draft root/backend proxy. Preserve query strings in redirects. Keep unknown URLs as 404s and do not expose application or administrative endpoints.
5. Run source tests, the engine TypeScript build and the offline VitePress build. Stage the existing installer without executing it. Build the real Dockerfile and verify its HTTP routing, assets, content, redirects and error behavior. Review both pages in desktop/mobile and light/dark modes. Use existing checks rather than introducing dependencies.
6. Obtain an independent Opus review of the actual candidate and resolve code blockers. Scan the staged diff for accidental credentials, private paths and unrelated files. Commit only the reviewed site changes and tests. Prepare a draft PR description; publishing, merge and deployment require separate approval.

## URL contract

- `/`: B2C homepage, served locally. GET/HEAD only.
- `/assets/*`: B2C static assets, never a backend proxy.
- `/creators/`: static creators page from `site/landing/creators/index.html`, exact URL only, GET/HEAD only. No form, script or tracking.
- `/creators`: permanent redirect to `/creators/`, keeping the query string. Other paths below `/creators/` (including `/creators/index.html`) are 404s.
- `/opensource/`: developer homepage and nested docs.
- `/opensource`: permanent redirect to `/opensource/`.
- `/open-source` and `/open-source/*`: permanent compatibility redirects to `/opensource/` and corresponding descendants.
- `/docs` and `/docs/*`: permanent redirects into the developer site.
- Existing root documentation prefixes and standalone documentation pages: permanent redirects to their matching `/opensource/` paths.
- `/install.sh`: same installer bytes as `/opensource/install.sh`.
- `/llms.txt`: redirect to `/opensource/llms.txt`.
- `/favicon.svg`: retain the existing site icon.
- Unknown pages and backend routes: 404, not a catch-all homepage.

## Local verification

```sh
node --test test/site-routing.test.mjs
npm run build
SPORTSCLAW_SITE_OFFLINE=1 npm run docs:build
```

Stage `scripts/install.sh` into the built docs and copy that output into ignored `site/html/`, as the existing site workflow does. Build with `docker build -f site/Dockerfile site`. Start only a disposable, loopback-bound container and pass its URL through `SPORTSCLAW_SITE_URL` to run the HTTP checks. Do not run the installer or send channel messages.

## Production release blockers

**This candidate is not approved for production.** The homepage shows only the existing Free and Pro ($12/month) plans, with qualitative usage (a daily allowance on Free, more daily usage on Pro) and no numeric caps or tier-gated features. This change does not alter backend quotas, subscriptions, billing or entitlements. Before merge/release, verify that the live entitlements and the `/upgrade` checkout match the Pro price and the plan copy, or obtain an explicitly approved copy change. A source comment or a successful site build is not entitlement enforcement.

The creators page is informational: it says applications aren't open and links only to the chat entry (`/#start-chat`). Before any creator applications open, approved privacy, terms and creator/disclosure policies, and their real destinations, are required; do not add an application form, tracking or payout terms until then.

The existing `.github/workflows/build-site.yml` supports a site-only `workflow_dispatch`; an engine/npm release is not required. Dispatch and deployment are outside this change's authorization. Before an eventual deployment, record the current image digest. After deployment, verify the exact running image and the URL contract above; retain the previous digest for rollback.

## Excluded

No runtime changes, pricing enforcement, live account checks, database changes, provider/channel credentials, chat sends, DNS changes, public PR creation, push, merge, deployment or package publication. No generated build output, dependency symlinks, private research or unrelated worktree changes belong in the commit.
