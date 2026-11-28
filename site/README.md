# Personal homepage and developer-site relocation plan

**Goal:** Serve the approved personal-agent page at `/`, an informational creators page at `/creators/`, review-draft privacy and terms pages at `/privacy/` and `/terms/`, and the existing developer site at `/opensource/` from one static site image.

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
- `/privacy/` and `/terms/`: static review drafts from `site/landing/privacy/index.html` and `site/landing/terms/index.html`, styled by `/assets/legal.css`. Exact URLs only, GET/HEAD only, `noindex`, no script, form or tracking. Each shows a "Draft for review. Not yet in effect." notice and links home and to the other draft; the homepage and creators footers link to both.
- `/privacy` and `/terms`: permanent redirects to the slash URL, keeping the query string. `/privacy/index.html`, `/terms/index.html`, other paths below them and look-alikes (`/privacyx`, `/terms.html`) are 404s. No prefix or regex locations match them.
- `/opensource/`: developer homepage and nested docs.
- `/opensource`: permanent redirect to `/opensource/`.
- `/open-source` and `/open-source/*`: permanent compatibility redirects to `/opensource/` and corresponding descendants.
- `/docs` and `/docs/*`: permanent redirects into the developer site.
- Existing root documentation prefixes and standalone documentation pages: permanent redirects to their matching `/opensource/` paths.
- `/install.sh`: same installer bytes as `/opensource/install.sh`.
- `/how-it-works/`: public, indexable consumer guide from `site/landing/how-it-works/index.html` (canonical `https://sportsclaw.gg/how-it-works/`). Exact URL only, GET/HEAD only, no script or form. `/how-it-works` permanently redirects to the slash URL with its query; other paths below it and look-alikes are 404s. It carries an editorial **historical example** (NBA, Knicks vs. Pacers Game 6, May 31, 2025, Pacers 125–108; points off turnovers 34–13, fast-break points 25–10) sourced from NBA.com's Nightly Pulse recap. It is not a captured chat or a live demo; no captured demo exists. Don't add times, causal claims or figures not in the source.
- `/llms.txt`: first-party site summary and navigation from `site/landing/llms.txt`, exact URL, GET/HEAD only. It links the developer index, which stays at `/opensource/llms.txt`.
- `/sitemap.xml`: from `site/landing/sitemap.xml`; lists only `/`, `/how-it-works/` and `/creators/`. Never the noindex legal drafts. `robots.txt` is unchanged (none is served).

### Homepage first question

The hero offers three starter questions. Without JavaScript, the default question is shown as selectable text and pre-drafted in every Telegram/WhatsApp link (hero, pricing, final). With JavaScript, the starter buttons rewrite only the `text` draft of every `a[data-chat]` link, keeping the exact recipients, and "Copy question" uses the Clipboard API, reporting a failure honestly and pointing to the visible text. The page makes no network requests and has no telemetry. The creators page links to the guide's public example; it adds no sharing, form or payout terms, and no creator clip has been produced.
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

### Legal drafts release checklist

`/privacy/` and `/terms/` are review drafts. They state they're not in effect, carry no effective date and are `noindex`. They cover the hosted site and the official Telegram/WhatsApp chats only, not self-hosted copies or a future native app. The only operator facts they state are that SportsClaw is built by Machina Sports and operated by GeniusTech Corporation (Delaware), with policy inquiries to support@machina.gg (as on https://machina.gg/privacy-policy). Before either page takes effect:

- [ ] Counsel approves the final text of both pages and sets the effective date. Then remove the draft notice and `noindex` and update the tests.
- [ ] Verify the production data flows match the privacy page: web request logs, the theme preference in local storage, messaging identifiers (Telegram IDs, WhatsApp numbers), messages and uploads, stored chat context and preferences, usage/diagnostics, and Stripe plan/transaction status and IDs.
- [ ] Verify which AI providers are used and how: what each receives, whether inputs are used for model training, and their retention. Add retention periods, training and sale/share statements, processing locations or a provider list only once verified.
- [ ] Confirm whether analytics or other tracking exist anywhere on the hosted service, and disclose them, along with the rights available in the regions served and how requests (access, correction, deletion, verification) are actually handled.
- [ ] Set the actual minimum age and any region restrictions, and the governing law and dispute terms. The drafts deliberately leave these open.
- [ ] Confirm the Stripe checkout shows the price and billing cadence before assent and links or presents these terms for assent; confirm recurring renewal, that `/billing` cancellation works, when access ends after cancelling, and the refund policy. The draft states no refund policy.

Before any future iOS app ships (it is out of scope for these pages):

- [ ] App Store privacy disclosures (privacy labels) match the app's actual data collection.
- [ ] Where personal data is shared with third-party AI providers, the app discloses it and obtains the user's permission as applicable.
- [ ] If the app lets users create accounts, it offers in-app account deletion.
- [ ] Billing for digital subscriptions in the app follows the actual store billing rules (in-app purchase where required), and the terms describe that billing.

The existing `.github/workflows/build-site.yml` supports a site-only `workflow_dispatch`; an engine/npm release is not required. Dispatch and deployment are outside this change's authorization. Before an eventual deployment, record the current image digest. After deployment, verify the exact running image and the URL contract above; retain the previous digest for rollback.

## Excluded

No runtime changes, pricing enforcement, live account checks, database changes, provider/channel credentials, chat sends, DNS changes, public PR creation, push, merge, deployment or package publication. No generated build output, dependency symlinks, private research or unrelated worktree changes belong in the commit.
