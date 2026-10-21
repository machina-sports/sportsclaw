// Migration contract for the static site image (see site/README.md):
//   /             personal-agent homepage, served from site/landing/
//   /opensource/  VitePress developer site
// Source checks always run. HTTP checks run only against a loopback URL passed
// explicitly as SPORTSCLAW_SITE_URL (for example a disposable local container).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const landingDir = join(root, "site", "landing");
const landingHtmlPath = join(landingDir, "index.html");

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const WORDMARKS = ["novig", "prophetx", "kalshi", "polymarket"];

// ---------- helpers ----------

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function stripCodeComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function visibleText(html) {
  return stripHtmlComments(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ");
}

// Local asset references in src="..." attributes and CSS url(...).
function landingAssetRefs(html) {
  const source = stripHtmlComments(html);
  const refs = [];
  for (const m of source.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  for (const m of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) refs.push(m[2]);
  return refs.filter((ref) => !ref.startsWith("#") && !ref.startsWith("data:"));
}

// Maps a reference from site/landing/index.html (served at /) to its file.
function resolveLandingAsset(ref) {
  const clean = decodeURIComponent(ref.split(/[?#]/)[0]);
  const urlPath = clean.startsWith("/") ? clean : posix.join("/", clean);
  if (!urlPath.startsWith("/assets/")) return null;
  const file = join(landingDir, ...urlPath.split("/").filter(Boolean));
  return relative(landingDir, file).startsWith("..") ? null : file;
}

function nginxConf() {
  return read("site", "nginx.conf").replace(/(^|\s)#.*$/gm, "$1");
}

function redirectTargets(conf) {
  return [
    ...[...conf.matchAll(/\breturn\s+30[1278]\s+(\S+?)\s*;/g)].map((m) => ({ kind: "return", target: m[1] })),
    ...[...conf.matchAll(/\brewrite\s+\S+\s+(\S+?)(?:\s+(\w+))?\s*;/g)].map((m) => ({ kind: "rewrite", target: m[1], flag: m[2] })),
  ];
}

function dockerCopies() {
  return [...read("site", "Dockerfile").matchAll(/^\s*COPY\s+(.+)$/gim)].map((m) => {
    const args = m[1].trim().split(/\s+/).filter((arg) => !arg.startsWith("--"));
    return { sources: args.slice(0, -1), dest: args.at(-1) };
  });
}

const normalizeDockerPath = (p) => p.replace(/\/\.$/, "").replace(/\/+$/, "") || "/";

function listFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["cache", "dist", "node_modules"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

// ---------- source checks ----------

test("VitePress builds the developer site under /opensource/", () => {
  const config = read("docs", ".vitepress", "config.mts");
  assert.match(config, /\bbase\s*:\s*["'`]\/opensource\/["'`]/);
  assert.match(config, /href\s*:\s*["'`]\/opensource\/favicon\.svg["'`]/, "head icon is not base-prefixed by VitePress");
  assert.match(config, /DOCS\s*=\s*`\$\{ORIGIN\}\/opensource`/, "llms.txt page URLs use the canonical prefix");

  const files = [
    join(root, "docs", ".vitepress", "config.mts"),
    ...listFiles(join(root, "docs", ".vitepress", "theme"), [".ts", ".mts", ".js", ".vue", ".css"]),
  ];
  const stale = [];
  for (const file of files) {
    stripCodeComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (/\/open-source\b/.test(line)) stale.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(stale, [], "developer site code still links to the old /open-source prefix");
});

test("Docker image copies the homepage locally and the docs below /opensource/", () => {
  const dockerfile = read("site", "Dockerfile");
  const copies = dockerCopies();
  const webRoot = "/usr/share/nginx/html";

  const toRoot = copies.filter((c) => normalizeDockerPath(c.dest) === webRoot);
  const rootSources = toRoot.flatMap((c) => c.sources.map(normalizeDockerPath));
  assert.ok(
    rootSources.includes("landing") ||
      (rootSources.includes("landing/index.html") && rootSources.includes("landing/assets")),
    `expected site/landing to be copied to ${webRoot}/, got ${JSON.stringify(copies)}`,
  );
  assert.ok(
    copies.some(
      (c) => normalizeDockerPath(c.dest) === `${webRoot}/opensource` && c.sources.map(normalizeDockerPath).includes("html"),
    ),
    `expected html/ to be copied to ${webRoot}/opensource/, got ${JSON.stringify(copies)}`,
  );
  assert.doesNotMatch(dockerfile, /open-source/);
  assert.doesNotMatch(dockerfile, /^\s*ADD\s+\S*https?:/im, "the image must not download content at build time");
  assert.doesNotMatch(dockerfile, /^\s*RUN\b.*\b(?:curl|wget)\b/im, "the image must not download content at build time");
});

test("nginx serves static files only, with no backend proxy", () => {
  const conf = nginxConf();
  for (const directive of ["proxy_pass", "fastcgi_pass", "uwsgi_pass", "scgi_pass", "grpc_pass", "upstream", "memcached_pass"]) {
    assert.doesNotMatch(conf, new RegExp(`\\b${directive}\\b`), `${directive} is not allowed`);
  }
  assert.doesNotMatch(conf, /svc\.cluster\.local|sportsclaw-machina-bridge/);
  assert.match(conf, /^\s*root\s+\/usr\/share\/nginx\/html\s*;/m);
  assert.match(conf, /\blocation\s+=\s*\/\s*\{/, "expected an exact location for the homepage");
  assert.match(conf, /\blocation\s+(?:\^~\s+)?\/assets\/\s*\{/, "expected a location for the homepage assets");
  assert.match(conf, /\blocation\s+(?:\^~\s+)?\/opensource\/\s*\{/, "expected a location for the developer site");
  assert.doesNotMatch(conf, /\bautoindex\s+on\b/, "directory listings are not allowed");

  // No SPA or homepage fallback: every try_files chain ends in a real 404.
  const tryFiles = [...conf.matchAll(/\btry_files\s+([^;]+);/g)];
  assert.ok(tryFiles.length > 0);
  for (const m of tryFiles) {
    assert.equal(m[1].trim().split(/\s+/).at(-1), "=404", `try_files ${m[1]} must end with =404`);
  }
});

// Routing itself is proven by the runtime checks against the real image.
test("nginx redirects are permanent, local to /opensource/ and keep the query", () => {
  const targets = redirectTargets(nginxConf());
  assert.ok(targets.length > 0, "expected legacy redirects");
  for (const { kind, target, flag } of targets) {
    assert.ok(target.startsWith("/opensource/"), `redirect to ${target}, expected /opensource/…`);
    if (kind === "return") {
      assert.match(target, /\$(?:is_args\$args|\?\$args|\?\$query_string)$/, `return ${target} drops the query string`);
    } else {
      assert.equal(flag, "permanent", `rewrite to ${target} must be a permanent redirect`);
      assert.ok(!target.includes("?"), `rewrite to ${target} drops the query string`);
    }
  }
});

test("installer stays at /install.sh with the same bytes as /opensource/install.sh", () => {
  assert.ok(existsSync(join(root, "scripts", "install.sh")));
  assert.match(
    read(".github", "workflows", "build-site.yml"),
    /cp\s+scripts\/install\.sh\s+docs\/public\/install\.sh/,
    "the installer must still be staged into the VitePress output",
  );
  assert.match(read("docs", ".vitepress", "config.mts"), /\$\{ORIGIN\}\/install\.sh/, "llms.txt advertises the root installer");

  const install = nginxConf().match(/\blocation\s+=\s*\/install\.sh\s*\{([^}]*)\}/);
  assert.ok(install, "expected an exact location for /install.sh");
  assert.deepEqual(redirectTargets(install[1]), [], "/install.sh is served directly, not redirected");
  assert.match(install[1], /\b(?:alias|try_files)\s+\/usr\/share\/nginx\/html\/opensource\/install\.sh\b|\btry_files\s+\/opensource\/install\.sh\b/);
});

test("homepage links point at /opensource/", () => {
  const html = readFileSync(landingHtmlPath, "utf8");
  assert.doesNotMatch(html, /href\s*[~^$*|]?=\s*["']?\/open-source/, "stale /open-source link or selector");

  const internal = [...stripHtmlComments(html).matchAll(/<a\b[^>]*?\shref\s*=\s*["'](\/[^"']*)["']/gi)].map((m) => m[1]);
  assert.ok(internal.includes("/opensource/"), "expected developer links to /opensource/");
  for (const href of internal) {
    assert.ok(href.startsWith("/opensource/"), `unexpected internal link ${href}`);
  }
});

test("every homepage asset reference exists locally", () => {
  const refs = landingAssetRefs(readFileSync(landingHtmlPath, "utf8"));
  assert.ok(refs.length > 0);

  const remote = refs.filter((ref) => /^(?:[a-z]+:)?\/\//i.test(ref));
  assert.deepEqual(remote, [], "homepage assets must be served from the image");

  const resolved = refs.map((ref) => [ref, resolveLandingAsset(ref)]);
  for (const [ref, file] of resolved) {
    assert.ok(file, `${ref} does not resolve inside site/landing/assets/`);
    assert.ok(existsSync(file) && statSync(file).isFile() && statSync(file).size > 0, `${ref} → ${relative(root, file)} is missing or empty`);
  }

  const files = resolved.map(([, file]) => relative(landingDir, file).split(sep).join("/"));
  assert.ok(files.some((f) => /^assets\/fonts\/.+\.woff2$/.test(f)), "expected the self-hosted fonts to be referenced");
  for (const mark of WORDMARKS) {
    assert.ok(files.includes(`assets/markets/${mark}-wordmark.svg`), `${mark} wordmark is not referenced`);
  }
});

test("all four market wordmarks are self-contained transparent SVGs", () => {
  for (const mark of WORDMARKS) {
    const file = join(landingDir, "assets", "markets", `${mark}-wordmark.svg`);
    assert.ok(existsSync(file), `${relative(root, file)} is missing`);
    const svg = readFileSync(file, "utf8");
    assert.match(svg, /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/, `${mark} is not an SVG`);
    assert.doesNotMatch(svg, /<image\b|<script\b|<foreignObject\b/i, `${mark} must be plain vector artwork`);
    assert.doesNotMatch(svg, /\bhref\s*=\s*["'](?:https?:)?\/\//i, `${mark} must not load external resources`);
    assert.doesNotMatch(svg, /(?<!enable-)background(?:-color)?\s*:/i, `${mark} sets a background`);

    // A painted rect covering the whole canvas is an opaque background. Rects
    // inside defs/clipPath/mask only shape other content.
    const painted = svg.replace(/<(defs|clipPath|mask)\b[\s\S]*?<\/\1>/gi, "");
    const viewBox = svg.match(/viewBox\s*=\s*["']([^"']+)["']/)?.[1].trim().split(/[\s,]+/).map(Number);
    for (const [rect] of painted.matchAll(/<rect\b[^>]*>/gi)) {
      const attr = (name) => rect.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
      const fill = attr("fill");
      if (fill && /^(?:none|transparent)$/i.test(fill)) continue;
      const full = (value, size) => value === "100%" || (viewBox && Math.abs(Number(value) - size) < 1);
      assert.ok(!(full(attr("width"), viewBox?.[2]) && full(attr("height"), viewBox?.[3])), `${mark} has a full-canvas background rect`);
    }
  }
});

test("homepage carries the approved copy", () => {
  const html = stripHtmlComments(readFileSync(landingHtmlPath, "utf8"));
  const text = visibleText(html);

  assert.match(text, /Free to start/);
  for (const [label, pattern] of [
    ["NFL", /\bNFL\b/],
    ["NBA", /\bNBA\b/],
    ["F1", /\bF1\b|Formula 1/],
    ["soccer", /\bsoccer\b/i],
  ]) {
    assert.match(text, pattern, `expected ${label} on the homepage`);
  }

  const max = html.match(/data-plan\s*=\s*["']max["']([\s\S]*?)(?:data-plan\s*=|<\/ol>)/);
  assert.ok(max, "expected a Max plan card");
  assert.match(visibleText(max[1]), /\bUnlimited\b/, "Max is presented as Unlimited");

  assert.doesNotMatch(
    text,
    /\b\d[\d,]*\s*(?:questions?|messages?|queries|prompts|asks|answers|replies|requests)\b/i,
    "no numeric question caps",
  );
  assert.doesNotMatch(text, /\b\d[\d,]*\s*(?:\/|per|a|each)\s*day\b/i, "no numeric daily caps");
  assert.doesNotMatch(text, /\billustrat(?:ive|ion|ed)\b/i, "no illustrative captions");
});

// ---------- optional runtime checks (loopback only) ----------

function siteTarget() {
  const raw = process.env.SPORTSCLAW_SITE_URL;
  if (!raw) return { mode: "off", reason: "SPORTSCLAW_SITE_URL not set; source-only mode" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { mode: "rejected", reason: `SPORTSCLAW_SITE_URL is not a URL: ${raw}` };
  }
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password) {
    return { mode: "rejected", reason: `SPORTSCLAW_SITE_URL must be a localhost or 127.0.0.1 origin, got ${url.origin}` };
  }
  return { mode: "ok", origin: url.origin };
}

const site = siteTarget();
const runtimeSkip = site.mode === "ok" ? false : site.reason;

async function request(path, init = {}) {
  return fetch(new URL(path, site.origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
}

async function bytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

function landingBytes() {
  return readFileSync(landingHtmlPath);
}

test("runtime: SPORTSCLAW_SITE_URL is a loopback origin", { skip: site.mode === "off" ? site.reason : false }, () => {
  assert.equal(site.mode, "ok", site.reason);
});

test("runtime: / serves the local homepage and /opensource/ the developer site", { skip: runtimeSkip }, async () => {
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") ?? "", /text\/html/);
  assert.ok((await bytes(home)).equals(landingBytes()), "/ must be site/landing/index.html");

  const docs = await request("/opensource/");
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
  const docsBody = await bytes(docs);
  assert.ok(!docsBody.equals(landingBytes()));
  assert.match(docsBody.toString("utf8"), /\/opensource\/assets\//);

  const quickstart = await request("/opensource/getting-started/quickstart");
  assert.equal(quickstart.status, 200);
  assert.match(quickstart.headers.get("content-type") ?? "", /text\/html/);
  const quickstartHtml = await quickstart.text();
  assert.match(quickstartHtml, /quickstart/i);
  assert.match(quickstartHtml, /\/opensource\/assets\//);
});

test("runtime: homepage fonts and wordmarks are served from the image", { skip: runtimeSkip }, async () => {
  const refs = landingAssetRefs(readFileSync(landingHtmlPath, "utf8"));
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const file = resolveLandingAsset(ref);
    assert.ok(file, `${ref} does not resolve locally`);
    const response = await request(new URL(ref, `${site.origin}/`).pathname);
    assert.equal(response.status, 200, `${ref} → ${response.status}`);
    if (ref.endsWith(".svg")) assert.match(response.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.ok((await bytes(response)).equals(readFileSync(file)), `${ref} differs from ${relative(root, file)}`);
  }
});

test("runtime: VitePress scripts and styles load from /opensource/assets/", { skip: runtimeSkip }, async () => {
  const html = await (await request("/opensource/")).text();
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']\/assets\//, "developer assets must not collide with the homepage /assets/");

  const assets = [...new Set([...html.matchAll(/(?:src|href)\s*=\s*["'](\/opensource\/assets\/[^"'?#]+\.(?:js|css))["']/g)].map((m) => m[1]))];
  assert.ok(assets.some((a) => a.endsWith(".js")), "expected a VitePress script");
  assert.ok(assets.some((a) => a.endsWith(".css")), "expected a VitePress stylesheet");
  for (const asset of assets.slice(0, 12)) {
    const response = await request(asset);
    assert.equal(response.status, 200, `${asset} → ${response.status}`);
    assert.match(response.headers.get("content-type") ?? "", asset.endsWith(".css") ? /text\/css/ : /javascript/);
    await response.body?.cancel();
  }
});

test("runtime: slash and legacy redirects are permanent, local and keep the query", { skip: runtimeSkip }, async () => {
  const cases = [
    ["/opensource?ref=test", "/opensource/?ref=test"],
    ["/open-source?ref=test", "/opensource/?ref=test"],
    ["/open-source/", "/opensource/"],
    ["/open-source/getting-started/quickstart?ref=test", "/opensource/getting-started/quickstart?ref=test"],
    ["/docs?ref=test", "/opensource/?ref=test"],
    ["/docs/getting-started/quickstart?ref=test", "/opensource/getting-started/quickstart?ref=test"],
    ["/getting-started/quickstart?ref=test", "/opensource/getting-started/quickstart?ref=test"],
    ["/cli-reference", "/opensource/cli-reference"],
    ["/machina?ref=test", "/opensource/machina?ref=test"],
    ["/getting-started?ref=test", "/opensource/getting-started?ref=test"],
    ["/llms.txt?ref=test", "/opensource/llms.txt?ref=test"],
  ];
  for (const [path, expected] of cases) {
    const response = await request(path);
    await response.body?.cancel();
    assert.ok([301, 308].includes(response.status), `${path} → ${response.status}, expected a permanent redirect`);
    const location = new URL(response.headers.get("location") ?? "", `${site.origin}${path}`);
    assert.equal(location.origin, site.origin, `${path} redirects off-site to ${location.href}`);
    assert.equal(location.pathname + location.search, expected, `${path} redirect target`);
  }

  const followed = await request("/docs/getting-started/quickstart", { redirect: "follow" });
  assert.equal(followed.status, 200);
  assert.equal(new URL(followed.url).pathname, "/opensource/getting-started/quickstart");
  await followed.body?.cancel();
});

test("runtime: legacy public brand assets retain their bytes", { skip: runtimeSkip }, async () => {
  for (const path of ["/logo-mark.svg", "/brand/machina-star.svg"]) {
    const legacy = await request(path);
    const canonical = await request(`/opensource${path}`);
    assert.equal(legacy.status, 200, path);
    assert.equal(canonical.status, 200, `/opensource${path}`);
    assert.match(legacy.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.ok((await bytes(legacy)).equals(await bytes(canonical)), `${path} changed`);
  }
});

test("Machina's raw HTML card stays inside the developer router base", () => {
  const page = readFileSync(join(root, "docs/machina/index.md"), "utf8");
  assert.match(page, /class="sc-doc-card" href="\/opensource\/getting-started\/quickstart"/);
});

test("runtime: unknown and backend routes are real 404s", { skip: runtimeSkip }, async () => {
  for (const path of [
    "/no-such-page-site-routing-test",
    "/opensource/no-such-page-site-routing-test",
    "/assets/no-such-asset-site-routing-test.js",
    "/api/health",
    "/billing",
    "/webhooks/stripe",
    "/admin",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 404, `${path} → ${response.status}`);
    assert.ok(!(await bytes(response)).equals(landingBytes()), `${path} must not fall back to the homepage`);
  }
});

test("runtime: non-GET requests to / do not serve the homepage", { skip: runtimeSkip }, async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await request("/", { method, body: method === "DELETE" ? undefined : "probe=1" });
    assert.ok(response.status >= 400, `${method} / → ${response.status}`);
    assert.ok(!(await bytes(response)).equals(landingBytes()), `${method} / served the homepage`);
  }
});

test("runtime: /install.sh is byte-identical to /opensource/install.sh", { skip: runtimeSkip }, async () => {
  // Fetched as data only; the installer is never executed.
  const rootInstall = await request("/install.sh");
  assert.equal(rootInstall.status, 200, "/install.sh must be served directly");
  const docsInstall = await request("/opensource/install.sh");
  assert.equal(docsInstall.status, 200);

  const a = await bytes(rootInstall);
  const b = await bytes(docsInstall);
  assert.ok(a.length > 0);
  assert.ok(a.equals(b), "/install.sh and /opensource/install.sh differ");
  assert.ok(a.equals(readFileSync(join(root, "scripts", "install.sh"))), "served installer differs from scripts/install.sh");

  const favicon = await request("/favicon.svg");
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type") ?? "", /image\/svg\+xml/);
  await favicon.body?.cancel();
});
