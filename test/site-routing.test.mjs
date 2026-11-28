// Migration contract for the static site image (see site/README.md):
//   /             personal-agent homepage, served from site/landing/
//   /creators/    informational creators page, site/landing/creators/
//   /privacy/     review-draft privacy page, site/landing/privacy/
//   /terms/       review-draft terms page, site/landing/terms/
//   /how-it-works/ public consumer guide, site/landing/how-it-works/
//   /llms.txt, /sitemap.xml  first-party discovery files, site/landing/
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
const creatorsHtmlPath = join(landingDir, "creators", "index.html");
const legalCssPath = join(landingDir, "assets", "legal.css");

// Static pages served at an exact directory URL, with an exact slash redirect.
const STATIC_PAGES = ["creators", "privacy", "terms", "how-it-works"];
const GUIDE_LINKS = ["/how-it-works/", "/how-it-works/#historical-example", "/how-it-works/#ask-your-team"];
const NBA_SOURCE = "https://www.nba.com/news/nightly-pulse-knicks-vs-pacers-game-6";
// Exact chat recipients; only the drafted text may change.
const CHAT_BASES = ["https://t.me/sportsclaw_machina_bot", "https://wa.me/19207777712"];
const DEFAULT_PROMPT = "What changed in my team's last game? Ask me which team first.";
const LEGAL_PAGES = ["privacy", "terms"];
const pageHtmlPath = (page) => join(landingDir, page, "index.html");
const SITE_FOOTER_LINKS = ["/privacy/", "/terms/"];

const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("consumer guide, question starters, and discovery are linked", () => {
  const home = readFileSync(landingHtmlPath, "utf8");
  assert.match(home, /href="\/how-it-works\/"/);
  assert.match(home, /Copy question/);
  assert.doesNotMatch(home, /hi%2C%20what%20can%20you%20do/i);
  const guide = readFileSync(pageHtmlPath("how-it-works"), "utf8");
  assert.match(guide, /rel="canonical" href="https:\/\/sportsclaw\.gg\/how-it-works\/"/);
  assert.match(guide, /historical example/i);
  assert.match(guide, /nba\.com/);
  assert.match(readFileSync(creatorsHtmlPath, "utf8"), /href="\/how-it-works\/#/);
  assert.match(read("site", "landing", "llms.txt"), /\/opensource\/llms\.txt/);
  assert.match(read("site", "landing", "sitemap.xml"), /https:\/\/sportsclaw\.gg\/how-it-works\//);
});

test("homepage hero is a labeled historical example, not a chat mock", () => {
  const html = stripHtmlComments(readFileSync(landingHtmlPath, "utf8"));
  const hero = html.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? "";
  const text = visibleText(hero);
  assert.match(text, /Historical example · editorial, not an actual chat/);
  assert.match(text, /May 31, 2025/);
  assert.match(text, /Pacers 125, Knicks 108/);
  assert.match(text, /34–13/);
  assert.match(text, /25–10/);
  assert.match(text, /NBA\.com/);
  assert.match(hero, /href="\/how-it-works\/#historical-example"/);
  assert.doesNotMatch(hero, /class="(?:phone|b you|b bot)"/, "no chat mock in the hero");
  assert.doesNotMatch(visibleText(html), /\blive demo\b|\bcaptured\b/i);
});

test("starter prompts draft the same question in every Telegram/WhatsApp pair", () => {
  const html = stripHtmlComments(readFileSync(landingHtmlPath, "utf8"));
  const chats = [...html.matchAll(/<a\b[^>]*\shref="(https:\/\/(?:t\.me|wa\.me)\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.equal(chats.length, 6, "three Telegram/WhatsApp pairs");
  for (const href of chats) {
    const url = new URL(href);
    assert.ok(CHAT_BASES.includes(url.origin + url.pathname), `unexpected recipient ${href}`);
    assert.deepEqual([...url.searchParams.keys()], ["text"]);
    assert.equal(url.searchParams.get("text"), DEFAULT_PROMPT, "no-JS default draft");
  }
  assert.equal([...html.matchAll(/<a\b[^>]*\bdata-chat\b[^>]*\shref="https:/g)].length, 6, "every chat link is updated by the picker");

  const prompts = [...html.matchAll(/<button\b[^>]*\bdata-prompt="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(prompts.length, 3);
  assert.equal(prompts[0], DEFAULT_PROMPT);
  assert.match(html, /<div class="starter-picks"[^>]*\bhidden\b/, "picker only appears with JS");
  assert.match(html, /<button class="copy-btn" type="button" data-copy hidden>Copy question<\/button>/);
  assert.match(visibleText(html.match(/<p class="starter-q"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? ""), new RegExp(DEFAULT_PROMPT.replace(/[?.]/g, "\\$&")));
  assert.match(html, /Couldn't copy\. Select the question above/);

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(scripts, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|new Image\(|analytics|gtag/i, "no network or telemetry");
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
});

test("how-it-works guide is static, sourced and links only where expected", () => {
  const html = stripHtmlComments(readFileSync(pageHtmlPath("how-it-works"), "utf8"));
  const text = visibleText(html);
  assert.doesNotMatch(html, /<script\b|<form\b|<input\b|<iframe\b|<img\b|noindex/i);
  for (const id of ["first-question", "historical-example", "ask-your-team"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(text, /May 31, 2025/);
  assert.match(text, /Pacers 125, Knicks 108/);
  assert.match(text, /isn't a captured SportsClaw chat/);
  assert.match(text, /within the same chat/i);
  assert.match(text, /no account, fantasy league or wallet to connect or sync/);
  assert.match(text, /never places bets or trades/);
  assert.doesNotMatch(text, /\billustrat(?:ive|ion|ed)\b|\$\d/i);

  const links = [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const homeChatLinks = [...readFileSync(landingHtmlPath, "utf8").matchAll(/<a\b[^>]*\bdata-chat\s+href="([^"]+)"/g)].map(([, href]) => href);
  const guideChatLinks = links.filter((href) => /^https:\/\/(?:t\.me|wa\.me)\//.test(href));
  assert.deepEqual(guideChatLinks, [...new Set(homeChatLinks)], "guide uses both approved chat destinations and matching drafts");
  for (const href of links) {
    assert.ok(["/", "/#start-chat", "/creators/", "/opensource/", "#main", NBA_SOURCE, ...SITE_FOOTER_LINKS, ...homeChatLinks].includes(href), `unexpected guide link ${href}`);
  }
  assert.ok(links.includes(NBA_SOURCE), "names and links the NBA.com source");
  const footer = footerLinks(html);
  for (const href of SITE_FOOTER_LINKS) assert.ok(footer.includes(href), `guide footer must link to ${href}`);
  for (const ref of landingAssetRefs(html)) {
    assert.ok(ref.startsWith("/assets/"), `${ref} must be a local /assets/ path`);
    const file = resolveLandingAsset(ref);
    assert.ok(file && existsSync(file) && statSync(file).size > 0, `${ref} is missing`);
  }
});

test("root llms.txt and sitemap.xml are first-party and narrow", () => {
  const llms = read("site", "landing", "llms.txt");
  assert.match(llms, /^# SportsClaw\n/);
  for (const url of ["https://sportsclaw.gg/", "https://sportsclaw.gg/how-it-works/", "https://sportsclaw.gg/creators/", "https://sportsclaw.gg/opensource/llms.txt"]) {
    assert.ok(llms.includes(`(${url})`), `llms.txt links ${url}`);
  }
  for (const url of llms.matchAll(/\]\((https?:[^)]+)\)/g)) assert.match(url[1], /^https:\/\/sportsclaw\.gg\//);

  const locs = [...read("site", "landing", "sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.sort(), ["https://sportsclaw.gg/", "https://sportsclaw.gg/creators/", "https://sportsclaw.gg/how-it-works/"]);

  const conf = nginxConf();
  for (const file of ["llms.txt", "sitemap.xml"]) {
    const block = conf.match(new RegExp(`\\blocation\\s+=\\s*/${file.replace(".", "\\.")}\\s*\\{([^}]*\\{[^}]*\\}[^}]*)\\}`));
    assert.ok(block, `expected an exact location for /${file}`);
    assert.match(block[1], /\blimit_except\s+GET\s*\{\s*deny\s+all\s*;\s*\}/);
    assert.match(block[1], new RegExp(`\\btry_files\\s+/${file.replace(".", "\\.")}\\s+=404\\s*;`));
    assert.deepEqual(redirectTargets(block[1]), []);
  }
  assert.ok(!existsSync(join(landingDir, "robots.txt")), "robots.txt is out of scope");
});

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
  assert.ok(
    rootSources.includes("landing") || rootSources.includes("landing/creators") ||
      copies.some((c) => normalizeDockerPath(c.dest) === `${webRoot}/creators` && c.sources.map(normalizeDockerPath).includes("landing/creators")),
    `expected site/landing/creators to reach ${webRoot}/creators/, got ${JSON.stringify(copies)}`,
  );
  for (const page of LEGAL_PAGES) {
    assert.ok(
      rootSources.includes("landing") || rootSources.includes(`landing/${page}`) ||
        copies.some((c) => normalizeDockerPath(c.dest) === `${webRoot}/${page}` && c.sources.map(normalizeDockerPath).includes(`landing/${page}`)),
      `expected site/landing/${page} to reach ${webRoot}/${page}/, got ${JSON.stringify(copies)}`,
    );
  }
  assert.ok(
    rootSources.includes("landing") || rootSources.includes("landing/assets"),
    `expected site/landing/assets (with legal.css) to reach ${webRoot}/assets/, got ${JSON.stringify(copies)}`,
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
  for (const page of STATIC_PAGES) {
    const block = conf.match(new RegExp(`\\blocation\\s+=\\s*/${page}/\\s*\\{([^}]*\\{[^}]*\\}[^}]*|[^}]*)\\}`));
    assert.ok(block, `expected an exact location for /${page}/`);
    assert.match(block[1], /\blimit_except\s+GET\s*\{\s*deny\s+all\s*;\s*\}/, `/${page}/ must restrict methods like /`);
    assert.match(block[1], new RegExp(`\\btry_files\\s+/${page}/index\\.html\\s+=404\\s*;`));
    assert.doesNotMatch(conf, new RegExp(`\\blocation\\s+(?:\\^~\\s+)?/${page}/?\\s*\\{`), `no prefix match for /${page} or below /${page}/`);
    assert.doesNotMatch(conf, new RegExp(`\\blocation\\s+~\\*?\\s+[^{]*${page}`), `no regex location matching ${page}`);
  }
  assert.doesNotMatch(conf, /\bautoindex\s+on\b/, "directory listings are not allowed");

  // No SPA or homepage fallback: every try_files chain ends in a real 404.
  const tryFiles = [...conf.matchAll(/\btry_files\s+([^;]+);/g)];
  assert.ok(tryFiles.length > 0);
  for (const m of tryFiles) {
    assert.equal(m[1].trim().split(/\s+/).at(-1), "=404", `try_files ${m[1]} must end with =404`);
  }
});

// Routing itself is proven by the runtime checks against the real image.
test("nginx redirects are permanent, local to /opensource/ (or a static page's slash URL) and keep the query", () => {
  const conf = nginxConf();
  const targets = redirectTargets(conf);
  assert.ok(targets.length > 0, "expected legacy redirects");
  for (const page of STATIC_PAGES) {
    const slash = conf.match(new RegExp(`\\blocation\\s+=\\s*/${page}\\s*\\{([^}]*)\\}`));
    assert.ok(slash, `expected an exact /${page} slash redirect`);
    assert.match(slash[1], /\breturn\s+301\b/, `/${page} must redirect permanently`);
    assert.deepEqual(redirectTargets(slash[1]).map((t) => t.target), [`/${page}/$is_args$args`]);
  }
  for (const { kind, target, flag } of targets) {
    const page = STATIC_PAGES.find((p) => target.startsWith(`/${p}/`));
    if (page) {
      assert.equal(target, `/${page}/$is_args$args`, `the only /${page}/ redirect is the exact slash redirect`);
      continue;
    }
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

function footerLinks(html) {
  const footer = stripHtmlComments(html).match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] ?? "";
  return [...footer.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
}

test("homepage links point at /opensource/, /creators/ and the legal drafts", () => {
  const html = readFileSync(landingHtmlPath, "utf8");
  assert.doesNotMatch(html, /href\s*[~^$*|]?=\s*["']?\/open-source/, "stale /open-source link or selector");

  const internal = [...stripHtmlComments(html).matchAll(/<a\b[^>]*?\shref\s*=\s*["'](\/[^"']*)["']/gi)].map((m) => m[1]);
  assert.ok(internal.includes("/opensource/"), "expected developer links to /opensource/");
  assert.ok(internal.includes("/creators/"), "expected links to /creators/");
  for (const href of internal) {
    assert.ok(
      href.startsWith("/opensource/") || ["/creators/", ...GUIDE_LINKS, ...SITE_FOOTER_LINKS].includes(href),
      `unexpected internal link ${href}`,
    );
  }
  const footer = footerLinks(html);
  for (const href of SITE_FOOTER_LINKS) assert.ok(footer.includes(href), `homepage footer must link to ${href}`);
});

test("creators page links and assets stay on the static site", () => {
  const html = readFileSync(creatorsHtmlPath, "utf8");
  const internal = [...stripHtmlComments(html).matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  for (const href of internal) {
    assert.ok(
      ["/", "/#start-chat", "/opensource/", "#main", ...GUIDE_LINKS, ...SITE_FOOTER_LINKS].includes(href),
      `unexpected creators link ${href}`,
    );
  }
  const footer = footerLinks(html);
  for (const href of SITE_FOOTER_LINKS) assert.ok(footer.includes(href), `creators footer must link to ${href}`);
  const refs = landingAssetRefs(html);
  assert.deepEqual(refs.filter((ref) => /^(?:[a-z]+:)?\/\//i.test(ref)), [], "creators assets must be served from the image");
  for (const ref of refs) {
    assert.ok(ref.startsWith("/assets/"), `${ref} must be an absolute /assets/ path from /creators/`);
    const file = resolveLandingAsset(ref);
    assert.ok(file && existsSync(file) && statSync(file).size > 0, `${ref} is missing`);
  }
  assert.doesNotMatch(visibleText(html), /\billustrat(?:ive|ion|ed)\b|\bpayouts? (?:of|up to)\b|\$\d/i);
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

  assert.match(visibleText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ""), /your personal sports AI agent/i);
  assert.deepEqual([...html.matchAll(/data-plan="([^"]+)"/g)].map(([, plan]) => plan), ["free", "pro"]);
  assert.doesNotMatch(text, /\bUnlimited\b|\/upgrade max/i);
  assert.doesNotMatch(
    text,
    /\b\d[\d,]*\s*(?:questions?|messages?|queries|prompts|asks|answers|replies|requests)\b/i,
    "no numeric question caps",
  );
  assert.doesNotMatch(text, /\b\d[\d,]*\s*(?:\/|per|a|each)\s*day\b/i, "no numeric daily caps");
  assert.doesNotMatch(text, /\billustrat(?:ive|ion|ed)\b/i, "no illustrative captions");
});

test("homepage links to an informational creators page", () => {
  const home = readFileSync(landingHtmlPath, "utf8");
  assert.equal([...home.matchAll(/href="\/creators\/"/g)].length, 2);
  const creators = readFileSync(new URL("../site/landing/creators/index.html", import.meta.url), "utf8");
  assert.match(visibleText(creators), /applications (?:are not|aren’t|aren't) open/i);
  assert.match(creators, /href="\/#start-chat"/);
  assert.doesNotMatch(creators, /<form\b|<input\b|<script\b|mailto:/i);
});

test("legal drafts are static, noindex, marked not in effect and linked to each other", () => {
  for (const page of LEGAL_PAGES) {
    const raw = readFileSync(pageHtmlPath(page), "utf8");
    const html = stripHtmlComments(raw);
    const text = visibleText(html);
    const other = page === "privacy" ? "terms" : "privacy";

    assert.match(html, /<meta\s+name="robots"\s+content="[^"]*\bnoindex\b[^"]*"\s*\/?>/i, `/${page}/ must be noindex`);
    assert.doesNotMatch(html, /rel="canonical"|property="og:/i, `/${page}/ draft must not advertise itself`);
    assert.match(text, /Draft for review\. Not yet in effect\./, `/${page}/ needs the draft notice`);
    assert.match(text, /has no effective date/i);
    assert.doesNotMatch(text, /\beffective (?:as of|on|from)\b|\blast updated\b/i, `/${page}/ must not state an effective date`);

    assert.deepEqual(
      [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]),
      ["/assets/legal.css"],
      `/${page}/ uses the shared stylesheet only`,
    );
    assert.doesNotMatch(html, /<style\b|<script\b|<form\b|<input\b|<iframe\b|<img\b|\bstyle=/i, `/${page}/ must be plain static HTML`);
    assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i, `/${page}/ must not load or link off-site resources`);

    const links = [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
    for (const href of links) {
      assert.ok(["/", "/privacy/", "/terms/", "#main", "mailto:support@machina.gg"].includes(href), `unexpected /${page}/ link ${href}`);
    }
    assert.ok(links.includes("/"), `/${page}/ links home`);
    assert.ok(links.includes(`/${other}/`), `/${page}/ links to /${other}/`);
    const footer = footerLinks(html);
    for (const href of ["/", "/privacy/", "/terms/"]) assert.ok(footer.includes(href), `/${page}/ footer links to ${href}`);

    for (const fact of [/Machina Sports/, /GeniusTech Corporation, a Delaware corporation/, /support@machina\.gg/, /Telegram/, /WhatsApp/]) {
      assert.match(text, fact, `/${page}/ is missing ${fact}`);
    }
    assert.match(text, /open-source agent that you or (?:anyone else|others) host/i, `/${page}/ excludes self-hosted copies`);
    assert.match(text, /future native app/i, `/${page}/ excludes a future native app`);

    // Nothing unverified: no fixed periods, named jurisdictions of processing or provider inventory.
    assert.doesNotMatch(text, /\b\d+\s*(?:hours?|days?|weeks?|months?|years?)\b/i, `/${page}/ states a fixed period`);
    assert.doesNotMatch(text, /\b(?:United States|U\.S\.|European|EU|EEA|GDPR|CCPA|California)\b/, `/${page}/ names a jurisdiction`);
    assert.doesNotMatch(text, /\b(?:OpenAI|Anthropic|Gemini|Google|AWS|Amazon|Azure|Microsoft|Twilio|Meta|Vercel|Cloudflare)\b/, `/${page}/ names an unverified provider`);
  }
});

test("privacy draft discloses the hosted service's data flows without unverified promises", () => {
  const text = visibleText(stripHtmlComments(readFileSync(pageHtmlPath("privacy"), "utf8")));
  for (const disclosure of [
    /IP address/,
    /local storage/,
    /Telegram user and chat IDs/,
    /WhatsApp phone number/,
    /supported uploads/,
    /Chat context and preferences/,
    /Usage and diagnostic information/,
    /Infrastructure providers/,
    /AI model providers/,
    /Stripe hosts the checkout/,
    /status of your payments and subscription, with the related Stripe identifiers/,
    /copy of your data, a correction or deletion/,
    /confirm the request comes from you/,
    /doesn't cancel a subscription/,
    /managed in those apps/,
    /doesn't set fixed retention periods/,
  ]) {
    assert.match(text, disclosure, `privacy draft is missing ${disclosure}`);
  }
  assert.doesNotMatch(text, /\bsell\b|\bsold\b|\brent\b|\b(?:never|not|don't|do not|won't|will not)\s+share\b/i, "no unverified sale/share claims");
  assert.doesNotMatch(text, /\btrain(?:s|ed|ing)?\b/i, "no unverified training claims");
  assert.doesNotMatch(text, /\bwithin\b|\bpromptly\b|\bbusiness days?\b/i, "no promised response time");
});

test("terms draft separates AI limits, read-only markets, billing and undecided terms", () => {
  const text = visibleText(stripHtmlComments(readFileSync(pageHtmlPath("terms"), "utf8")));
  for (const clause of [
    /answers can be wrong, incomplete or out of date/i,
    /not professional, financial, legal or betting advice/,
    /doesn't place bets or trades, take deposits/,
    /have their own terms/,
    /Please don't/,
    /isn't a trial/,
    /recurring paid subscription/,
    /shows the price and how often you're billed before you agree to pay/,
    /renews each billing period until you cancel/,
    /\/billing/,
    /\/upgrade/,
    /doesn't set a refund policy/,
    /no SportsClaw creator program/,
    /doesn't yet set any region restrictions, the law that governs these terms or how disputes are resolved/,
    /consumer protection law that can't be waived/,
    /at least 18 and allowed to use SportsClaw under the law where you live/,
  ]) {
    assert.match(text, clause, `terms draft is missing ${clause}`);
  }
  assert.doesNotMatch(text, /arbitrat|class action|jury|\bcourts?\b|governed by the laws? of|\bvenue\b/i, "no invented dispute terms");
  assert.deepEqual([...text.matchAll(/\b(\d{2})\b/g)].map((m) => m[1]), ["18"], "only the agreed proposed age of 18");
  assert.doesNotMatch(text, /\bage of (?:majority|\d)/i, "no other age cutoff");
  assert.doesNotMatch(text, /\b(?:full|partial|pro-?rat(?:ed|a))\s+refunds?\b|\brefunds? (?:within|are|will)\b|\bnon-?refundable\b/i, "no invented refund terms");
  assert.doesNotMatch(text, /\$\d|\bfree trial\b/i, "price and cadence come from checkout");
});

// iPhone provisions are proposals only: never active, approved or shipped.
const IOS_SECTION = /<h2>If an iPhone app is released \(proposed, not active\)<\/h2>([\s\S]*?)(?=<h2>)/;
const IOS_OVERCLAIMS = /\b(?:approved by Apple|Apple (?:has )?approved|available (?:on|in) the App Store|download (?:it|the app)|now available|is live)\b/i;

test("privacy draft separates AI processing and keeps iPhone provisions proposed", () => {
  const html = stripHtmlComments(readFileSync(pageHtmlPath("privacy"), "utf8"));
  const text = visibleText(html);
  for (const clause of [
    /AI processing/,
    /may process your message, supported uploads and relevant chat context/,
    /records the law requires us to keep/,
  ]) {
    assert.match(text, clause, `privacy draft is missing ${clause}`);
  }
  const ios = visibleText(html.match(IOS_SECTION)?.[1] ?? "");
  assert.ok(ios, "privacy draft needs the proposed iPhone section");
  for (const clause of [
    /doesn't cover native app operations/,
    /App Store privacy details/,
    /explicit permission before sending that data/,
    /withdraw that permission/,
    /start deleting it in the app/,
  ]) {
    assert.match(ios, clause, `privacy iPhone section is missing ${clause}`);
  }
  assert.doesNotMatch(text, IOS_OVERCLAIMS, "no claim the app is approved or shipped");
});

test("terms draft keeps Stripe billing separate from proposed Apple billing", () => {
  const html = stripHtmlComments(readFileSync(pageHtmlPath("terms"), "utf8"));
  const text = visibleText(html);
  assert.match(text, /subscriptions started from the website or the official chats, which are paid through Stripe/);
  const ios = visibleText(html.match(IOS_SECTION)?.[1] ?? "");
  assert.ok(ios, "terms draft needs the proposed iPhone section");
  for (const clause of [
    /don't cover native app operations/,
    /only if the iPhone app offers a subscription through Apple/,
    /purchased through Apple/,
    /renew automatically until you cancel/,
    /manage or cancel it in your Apple account's subscription settings/,
    /Refund requests for Apple purchases would go to Apple/,
    /Apple's standard end user license agreement/,
    /read-only market limits above would also apply/,
  ]) {
    assert.match(ios, clause, `terms iPhone section is missing ${clause}`);
  }
  assert.doesNotMatch(text, IOS_OVERCLAIMS, "no claim the app is approved or shipped");
});

test("legal stylesheet is small, local and only references local fonts", () => {
  const css = readFileSync(legalCssPath, "utf8");
  assert.ok(css.length > 0 && css.length < 8_000, "legal.css should stay small");
  assert.doesNotMatch(css, /@import\b/i);
  const refs = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((m) => m[2]);
  assert.ok(refs.length > 0, "expected the self-hosted fonts");
  for (const ref of refs) {
    assert.ok(ref.startsWith("/assets/fonts/"), `${ref} must be an absolute /assets/fonts/ path`);
    const file = resolveLandingAsset(ref);
    assert.ok(file && existsSync(file) && statSync(file).size > 0, `${ref} is missing`);
  }
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

test("runtime: /creators/ serves the static creators page, GET only", { skip: runtimeSkip }, async () => {
  const creatorsBytes = readFileSync(creatorsHtmlPath);

  const page = await request("/creators/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.ok((await bytes(page)).equals(creatorsBytes), "/creators/ must be site/landing/creators/index.html");

  for (const [path, expected] of [
    ["/creators", "/creators/"],
    ["/creators?ref=test", "/creators/?ref=test"],
    ["/creators?ref=test&utm_source=x", "/creators/?ref=test&utm_source=x"],
  ]) {
    const response = await request(path);
    await response.body?.cancel();
    assert.ok([301, 308].includes(response.status), `${path} → ${response.status}, expected a permanent redirect`);
    const location = new URL(response.headers.get("location") ?? "", `${site.origin}${path}`);
    assert.equal(location.origin, site.origin, `${path} redirects off-site to ${location.href}`);
    assert.equal(location.pathname + location.search, expected, `${path} redirect target`);
  }

  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await request("/creators/", { method, body: method === "DELETE" ? undefined : "probe=1" });
    assert.ok(response.status >= 400, `${method} /creators/ → ${response.status}`);
    assert.ok(!(await bytes(response)).equals(creatorsBytes), `${method} /creators/ served the page`);
  }

  for (const path of ["/creators/index.html", "/creators/apply", "/creators/no-such-page-site-routing-test", "/creatorsx"]) {
    const response = await request(path);
    assert.equal(response.status, 404, `${path} → ${response.status}`);
    const body = await bytes(response);
    assert.ok(!body.equals(creatorsBytes) && !body.equals(landingBytes()), `${path} must not fall back to a page`);
  }
});

test("runtime: /privacy/ and /terms/ serve the static drafts, GET only, exact URLs", { skip: runtimeSkip }, async () => {
  const css = await request("/assets/legal.css");
  assert.equal(css.status, 200, "/assets/legal.css");
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.ok((await bytes(css)).equals(readFileSync(legalCssPath)), "/assets/legal.css differs from site/landing/assets/legal.css");

  for (const page of LEGAL_PAGES) {
    const pageBytes = readFileSync(pageHtmlPath(page));
    const fallbacks = [pageBytes, landingBytes(), readFileSync(creatorsHtmlPath)];

    const response = await request(`/${page}/`);
    assert.equal(response.status, 200, `/${page}/`);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.ok((await bytes(response)).equals(pageBytes), `/${page}/ must be site/landing/${page}/index.html`);

    for (const [path, expected] of [
      [`/${page}`, `/${page}/`],
      [`/${page}?ref=test`, `/${page}/?ref=test`],
      [`/${page}?ref=test&utm_source=x`, `/${page}/?ref=test&utm_source=x`],
    ]) {
      const redirect = await request(path);
      await redirect.body?.cancel();
      assert.ok([301, 308].includes(redirect.status), `${path} → ${redirect.status}, expected a permanent redirect`);
      const location = new URL(redirect.headers.get("location") ?? "", `${site.origin}${path}`);
      assert.equal(location.origin, site.origin, `${path} redirects off-site to ${location.href}`);
      assert.equal(location.pathname + location.search, expected, `${path} redirect target`);
    }

    for (const method of ["POST", "PUT", "DELETE"]) {
      const denied = await request(`/${page}/`, { method, body: method === "DELETE" ? undefined : "probe=1" });
      assert.ok(denied.status >= 400, `${method} /${page}/ → ${denied.status}`);
      assert.ok(!(await bytes(denied)).equals(pageBytes), `${method} /${page}/ served the page`);
    }

    for (const path of [`/${page}/index.html`, `/${page}/no-such-page-site-routing-test`, `/${page}x`, `/${page}.html`]) {
      const missing = await request(path);
      assert.equal(missing.status, 404, `${path} → ${missing.status}`);
      const body = await bytes(missing);
      assert.ok(!fallbacks.some((b) => body.equals(b)), `${path} must not fall back to a page`);
    }
  }
});

test("runtime: /how-it-works/, /llms.txt and /sitemap.xml are exact, GET/HEAD only", { skip: runtimeSkip }, async () => {
  const guideBytes = readFileSync(pageHtmlPath("how-it-works"));
  const fallbacks = [guideBytes, landingBytes(), readFileSync(creatorsHtmlPath)];

  for (const [path, file, type] of [
    ["/how-it-works/", pageHtmlPath("how-it-works"), /text\/html/],
    ["/llms.txt", join(landingDir, "llms.txt"), /text\/plain/],
    ["/sitemap.xml", join(landingDir, "sitemap.xml"), /xml/],
  ]) {
    const expected = readFileSync(file);
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", type, `${path} content type`);
    assert.ok((await bytes(response)).equals(expected), `${path} must be ${relative(root, file)}`);

    const head = await request(path, { method: "HEAD" });
    assert.equal(head.status, 200, `HEAD ${path}`);
    await head.body?.cancel();

    for (const method of ["POST", "PUT", "DELETE"]) {
      const denied = await request(path, { method, body: method === "DELETE" ? undefined : "probe=1" });
      assert.ok(denied.status >= 400, `${method} ${path} → ${denied.status}`);
      assert.ok(!(await bytes(denied)).equals(expected), `${method} ${path} served the file`);
    }
  }

  for (const [path, expected] of [
    ["/how-it-works", "/how-it-works/"],
    ["/how-it-works?ref=test", "/how-it-works/?ref=test"],
  ]) {
    const redirect = await request(path);
    await redirect.body?.cancel();
    assert.ok([301, 308].includes(redirect.status), `${path} → ${redirect.status}, expected a permanent redirect`);
    const location = new URL(redirect.headers.get("location") ?? "", `${site.origin}${path}`);
    assert.equal(location.origin, site.origin);
    assert.equal(location.pathname + location.search, expected, `${path} redirect target`);
  }

  for (const path of ["/how-it-works/index.html", "/how-it-works/no-such-page-site-routing-test", "/how-it-worksx", "/how-it-works.html"]) {
    const missing = await request(path);
    assert.equal(missing.status, 404, `${path} → ${missing.status}`);
    const body = await bytes(missing);
    assert.ok(!fallbacks.some((b) => body.equals(b)), `${path} must not fall back to a page`);
  }

  const docsLlms = await request("/opensource/llms.txt");
  assert.equal(docsLlms.status, 200, "/opensource/llms.txt stays served directly");
  assert.ok(!(await bytes(docsLlms)).equals(readFileSync(join(landingDir, "llms.txt"))), "developer llms.txt is separate");

  const robots = await request("/robots.txt");
  await robots.body?.cancel();
  assert.equal(robots.status, 404, "robots.txt unchanged (absent)");
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
