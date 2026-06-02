#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function usage() {
  console.log(`Wikify

Usage:
  wikify init [--agent claude|codex|cursor|opencode] [--agents a,b,c] [--with-pr-history|--no-pr-history] [--root DIR]
  wikify build [--root DIR]
  wikify connect github [--root DIR]
  wikify update [--pr-history] [--root DIR]
  wikify health [--root DIR]
  wikify serve [--root DIR] [--port 4173]

Examples:
  npx @invariance/wikify init --agent claude --with-pr-history
  npx @invariance/wikify init --agents claude,codex,cursor,opencode --no-pr-history
  npx @invariance/wikify build
  npx @invariance/wikify connect github
  npx @invariance/wikify update --pr-history
  npx @invariance/wikify health
  npx @invariance/wikify serve
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "with-pr-history" || key === "no-pr-history") {
      args[key] = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

function mkdirp(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeIfMissing(filePath, content) {
  mkdirp(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    return true;
  }
  return false;
}

function upsertManagedBlock(filePath, start, end, content) {
  mkdirp(filePath);
  const block = `${start}\n${content.trim()}\n${end}\n`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block);
    return;
  }
  const existing = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  if (pattern.test(existing)) {
    fs.writeFileSync(filePath, existing.replace(pattern, block));
  } else {
    fs.writeFileSync(filePath, `${existing.trimEnd()}\n\n${block}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wikiPage(title, description, body) {
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n\n# ${title}\n\n${body.trim()}\n`;
}

function repoName(root) {
  return path.basename(root) || "Repository";
}

function initWiki(root, opts) {
  const wiki = path.join(root, ".wiki");
  const withPrHistory = Boolean(opts["with-pr-history"]);
  const noPrHistory = Boolean(opts["no-pr-history"]);
  const prMode = withPrHistory ? "with PR history" : noPrHistory ? "without PR history" : "without PR history";

  fs.mkdirSync(wiki, { recursive: true });
  writeIfMissing(path.join(wiki, "index.md"), wikiPage(
    `${repoName(root)} Wiki`,
    "A living in-repo wiki for humans and coding agents.",
    `This wiki is the durable memory for this repository. The Markdown files under \`.wiki/\` are the source of truth for agents. The HTML files under \`.wiki/_site/\` are the human-readable mirror.\n\n## Start here\n\n- [[architecture]]\n- [[decisions]]\n- [[todos]]\n- [[gotchas]]\n- [[prs-and-tickets]]\n- [[agent-protocol]]\n\nInitialized ${prMode}.\n\n## Mirror rule\n\nWhen a wiki Markdown page changes, run:\n\n\`\`\`bash\nwikify build\n\`\`\`\n\nThat regenerates the HTML mirror in \`.wiki/_site/\`.`
  ));
  writeIfMissing(path.join(wiki, "architecture.md"), wikiPage(
    "Architecture",
    "How this repository is structured.",
    `This page should explain the repo layout, runtime boundaries, important modules, and data flow.\n\n## Current map\n\nRun \`wikify build\` after filling this page so the HTML mirror stays current.\n\n## Related\n\n- [[decisions]]\n- [[gotchas]]`
  ));
  writeIfMissing(path.join(wiki, "decisions.md"), wikiPage(
    "Decisions",
    "Durable decisions and rejected alternatives.",
    `Newest first.\n\n## Initial wiki setup\n\n**Decision.** Keep agent-readable Markdown and human-readable HTML as mirrors.\n\n**Why.** Agents need cheap text context in \`.wiki/*.md\`; humans need a browsable, linkable site in \`.wiki/_site/*.html\`.`
  ));
  writeIfMissing(path.join(wiki, "todos.md"), wikiPage(
    "TODOs",
    "Persistent work that should survive agent sessions.",
    `- [ ] Fill in [[architecture]] with the real repo map.\n- [ ] Add known footguns to [[gotchas]].\n- [ ] Record durable decisions in [[decisions]].`
  ));
  writeIfMissing(path.join(wiki, "gotchas.md"), wikiPage(
    "Gotchas",
    "Known footguns and pitfalls.",
    `Add hard-won repo-specific gotchas here.\n\n## Wiki mirror gotcha\n\nIf a Markdown page changes and the HTML site looks stale, run \`wikify build\`.`
  ));
  writeIfMissing(path.join(wiki, "prs-and-tickets.md"), wikiPage(
    "PRs and tickets",
    "Pull request, issue, ticket and external workflow context.",
    `This page is seeded by \`wikify init --with-pr-history\` or later by \`wikify connect github\`.\n\n## Init mode\n\n${withPrHistory ? "PR history import requested. Connect GitHub and import merged PRs/issues here." : "Local-only initialization. Run `wikify connect github` later to import PR history."}`
  ));
  writeIfMissing(path.join(wiki, "agent-protocol.md"), wikiPage(
    "Agent protocol",
    "How coding agents should read and maintain this wiki.",
    `Read [[index]] at session start. Update this wiki when the session creates durable repo knowledge: decisions, gotchas, persistent TODOs, architecture changes, PR context, user corrections, or external ticket context.\n\nDo not store secrets or transient progress.\n\nAfter wiki edits, run:\n\n\`\`\`bash\nwikify build\nwikify health\n\`\`\`\n\nThe Markdown files are the source of truth. The HTML files in \`.wiki/_site/\` are generated mirrors for humans.`
  ));

  const agents = selectedAgents(opts);
  if (agents.has("claude")) installClaude(root);
  if (agents.has("codex")) installCodex(root);
  if (agents.has("cursor")) installCursor(root);
  if (agents.has("opencode")) installOpenCode(root);

  buildSite(root);

  console.log(`Initialized Wikify in ${wiki}`);
  console.log(`Rendered HTML mirror in ${path.join(wiki, "_site")}`);
  console.log(`Mode: ${withPrHistory ? "with PR history requested" : "no PR history import"}`);
  console.log(`Agents: ${agents.size ? [...agents].join(", ") : "none"}`);
  console.log("Open: .wiki/_site/index.html");
}

function selectedAgents(opts) {
  const agents = new Set();
  if (opts.agent) agents.add(opts.agent);
  if (opts.agents) {
    for (const agent of opts.agents.split(",")) {
      if (agent.trim()) agents.add(agent.trim());
    }
  }
  return agents;
}

function installClaude(root) {
  upsertManagedBlock(path.join(root, "CLAUDE.md"), "<!-- wikify:start -->", "<!-- wikify:end -->", `
# Wikify Repo Memory

At session start, read \`.wiki/index.md\` and \`.wiki/agent-protocol.md\`.
Before final response, update \`.wiki/\` if durable repo knowledge changed.
Do not store secrets in \`.wiki/\`.
`);
  writeIfMissing(path.join(root, ".claude/skills/wikify/SKILL.md"), `# Wikify\n\nRead .wiki/index.md and .wiki/agent-protocol.md before meaningful work. Update .wiki/ when durable repo knowledge changes.\n`);
  writeIfMissing(path.join(root, ".claude/settings.json"), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "test -f .wiki/index.md && printf '\\n[Wikify] Read .wiki/index.md and .wiki/agent-protocol.md.\\n' || true" }] }]
    }
  }, null, 2));
}

function installCodex(root) {
  upsertManagedBlock(path.join(root, "AGENTS.md"), "<!-- wikify:start -->", "<!-- wikify:end -->", `
# Wikify Repo Memory

Read \`.wiki/index.md\` and \`.wiki/agent-protocol.md\` at session start. Update \`.wiki/\` when durable repo knowledge changes.
`);
  upsertManagedBlock(path.join(root, ".codex/config.toml"), "# wikify:start", "# wikify:end", `notify = ["bash", "-lc", "test -f .wiki/index.md && echo '[Wikify] Review .wiki before closeout.' || true"]`);
}

function installCursor(root) {
  writeIfMissing(path.join(root, ".cursor/rules/wikify.mdc"), `---\ndescription: Wikify repo memory. Read and maintain .wiki/.\nalwaysApply: true\n---\n\nRead .wiki/index.md and .wiki/agent-protocol.md at session start. Update .wiki/ when durable repo knowledge changes.\n`);
}

function installOpenCode(root) {
  writeIfMissing(path.join(root, ".opencode/wikify.md"), `# Wikify\n\nRead .wiki/index.md and .wiki/agent-protocol.md at session start. Update .wiki/ before closeout when durable repo knowledge changes.\n`);
}

function health(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error("No .wiki/ found. Run `wikify init` first.");
    process.exitCode = 1;
    return;
  }
  const pages = fs.readdirSync(wiki, { recursive: true })
    .filter((file) => typeof file === "string" && file.endsWith(".md"));
  const text = pages.map((file) => fs.readFileSync(path.join(wiki, file), "utf8")).join("\n");
  const links = (text.match(/\[\[[^\]]+\]\]/g) || []).length;
  const todos = (text.match(/- \[ \]/g) || []).length;
  const gotchas = fs.existsSync(path.join(wiki, "gotchas.md")) ? 1 : 0;
  const score = Math.min(100, 40 + Math.min(20, pages.length * 3) + Math.min(20, links) + Math.min(10, todos * 2) + gotchas * 10);
  console.log(`Repo Memory Score: ${score}/100\n`);
  console.log("Found:");
  console.log(`- ${pages.length} wiki pages`);
  console.log(`- ${links} internal wiki links`);
  console.log(`- ${todos} persistent todos`);
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n")) {
    return [{}, raw];
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return [{}, raw];
  }
  const meta = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx !== -1) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return [meta, raw.slice(end + 4).replace(/^\n+/, "")];
}

function slugForFile(file) {
  const normalized = file.replace(/\\/g, "/").replace(/\.md$/, "");
  return normalized === "index" ? "index" : normalized.replace(/[^a-zA-Z0-9/_-]/g, "-");
}

function htmlFileForSlug(slug) {
  return `${slug}.html`;
}

function titleFromSlug(slug) {
  return slug.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  return value.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

function renderInline(text, pagesBySlug) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_, body) => {
    const [targetPart, labelPart] = body.split("|");
    const [target, anchor] = targetPart.split("#");
    const slug = target.trim();
    const label = (labelPart || target).trim();
    if (!pagesBySlug.has(slug)) {
      return `<a class="missing" href="#">${escapeHtml(label)}</a>`;
    }
    return `<a href="${htmlFileForSlug(slug)}${anchor ? `#${escapeHtml(anchor.trim())}` : ""}">${escapeHtml(label)}</a>`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
  return out;
}

function renderMarkdown(markdown, pagesBySlug) {
  const lines = markdown.split("\n");
  const html = [];
  let paragraph = [];

  function flushParagraph() {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "), pagesBySlug)}</p>`);
      paragraph = [];
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      html.push(`<h${level} id="${id}">${renderInline(text, pagesBySlug)}</h${level}>`);
      continue;
    }
    if (line.startsWith("```")) {
      flushParagraph();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*]\s+/, ""), pagesBySlug)}</li>`);
        i += 1;
      }
      i -= 1;
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""), pagesBySlug)}</li>`);
        i += 1;
      }
      i -= 1;
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return html.join("\n");
}

function collectWikiPages(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) return [];
  const files = fs.readdirSync(wiki, { recursive: true })
    .filter((file) => typeof file === "string" && file.endsWith(".md"))
    .filter((file) => !file.startsWith("_site/"))
    .sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(wiki, file), "utf8");
    const [meta, body] = parseFrontmatter(raw);
    const slug = slugForFile(file);
    return {
      file,
      slug,
      title: meta.title || titleFromSlug(slug),
      description: meta.description || "",
      body,
      raw,
    };
  });
}

function renderPage(page, pages, pagesBySlug) {
  const nav = pages.map((p) => `<li><a href="${htmlFileForSlug(p.slug)}"${p.slug === page.slug ? ' class="active"' : ""}>${escapeHtml(p.title)}</a></li>`).join("");
  const body = renderMarkdown(page.body, pagesBySlug);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · Wikify</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="stylesheet" href="style.css">
</head>
<body>
<aside>
  <a class="brand" href="index.html">Wikify</a>
  <nav><ul>${nav}</ul></nav>
</aside>
<main>
  <div class="meta">Mirrored from <code>.wiki/${escapeHtml(page.file)}</code></div>
  ${body}
</main>
</body>
</html>`;
}

const SITE_CSS = `:root{--ink:#202122;--muted:#54595d;--line:#c8ccd1;--panel:#f8f9fa;--link:#0645ad;--amber:#f4a020}
*{box-sizing:border-box}body{margin:0;color:var(--ink);font:16px/1.55 Georgia,serif;background:#fff;display:flex}
aside{width:230px;min-height:100vh;border-right:1px solid var(--line);padding:18px 14px;position:sticky;top:0;background:var(--panel);font-family:Inter,-apple-system,Segoe UI,sans-serif}
.brand{display:block;color:var(--ink);font-weight:800;text-decoration:none;margin-bottom:18px;font-size:20px}
nav ul{list-style:none;margin:0;padding:0}nav a{display:block;padding:5px 7px;border-radius:4px;color:var(--link);text-decoration:none;font-size:14px}
nav a:hover{background:#fff;text-decoration:underline}nav a.active{background:#fff3d6;color:var(--ink);box-shadow:inset 3px 0 0 var(--amber)}
main{max-width:860px;padding:34px 42px 80px}h1,h2,h3{font-weight:500;line-height:1.25}h1{font-size:34px;border-bottom:1px solid var(--line);padding-bottom:8px}h2{font-size:25px;border-bottom:1px solid #eaecf0;padding-bottom:5px;margin-top:1.5em}
a{color:var(--link)}a.missing{color:#ba0000}code{background:var(--panel);border:1px solid #eaecf0;border-radius:3px;padding:.08em .35em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
pre{background:#20242a;color:#f4f4f4;border-left:4px solid var(--amber);padding:14px;overflow:auto}.meta{font:13px Inter,-apple-system,Segoe UI,sans-serif;color:var(--muted);margin-bottom:10px}
@media(max-width:800px){body{display:block}aside{position:static;width:auto;min-height:0;border-right:none;border-bottom:1px solid var(--line)}main{padding:22px}}`;

function buildSite(root) {
  const wiki = path.join(root, ".wiki");
  if (!fs.existsSync(wiki)) {
    console.error("No .wiki/ found. Run `wikify init` first.");
    process.exitCode = 1;
    return;
  }
  const out = path.join(wiki, "_site");
  fs.mkdirSync(out, { recursive: true });
  const pages = collectWikiPages(root);
  const pagesBySlug = new Map(pages.map((page) => [page.slug, page]));
  for (const page of pages) {
    const output = path.join(out, htmlFileForSlug(page.slug));
    mkdirp(output);
    fs.writeFileSync(output, renderPage(page, pages, pagesBySlug));
  }
  fs.writeFileSync(path.join(out, "style.css"), SITE_CSS);
  fs.writeFileSync(path.join(out, "search-index.json"), JSON.stringify(pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    description: page.description,
    text: page.body.replace(/\s+/g, " ").trim(),
  })), null, 2));
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify({
    nodes: pages.map((page) => ({ slug: page.slug, title: page.title, file: page.file })),
    links: pages.flatMap((page) => {
      const links = [...page.raw.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
        .map((match) => match[1].trim())
        .filter((target) => pagesBySlug.has(target));
      return links.map((target) => ({ source: page.slug, target }));
    }),
  }, null, 2));
  console.log(`Built ${pages.length} HTML pages -> ${out}`);
}

function serve(root, port) {
  const site = path.join(root, ".wiki/_site");
  const wiki = path.join(root, ".wiki");
  const base = fs.existsSync(site) ? site : wiki;
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    const file = pathname === "/" ? (base === site ? "index.html" : "index.md") : pathname.slice(1);
    const fullPath = path.normalize(path.join(base, file));
    if (!fullPath.startsWith(base) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    res.end(fs.readFileSync(fullPath));
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Wikify serving ${base} at http://127.0.0.1:${port}/`);
  });
}

function connect(root, provider) {
  if (provider !== "github") {
    console.error("Only `wikify connect github` is defined in this prototype.");
    process.exitCode = 1;
    return;
  }
  const page = path.join(root, ".wiki/prs-and-tickets.md");
  if (!fs.existsSync(page)) {
    console.error("No .wiki/prs-and-tickets.md found. Run `wikify init` first.");
    process.exitCode = 1;
    return;
  }
  console.log("GitHub connection placeholder created.");
  console.log("Next implementation: authenticate with gh/GITHUB_TOKEN, import merged PRs/issues, and update .wiki/prs-and-tickets.md.");
}

function update(root, opts) {
  if (opts["pr-history"]) {
    connect(root, "github");
    return;
  }
  health(root);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const root = path.resolve(args.root || process.cwd());

if (!command || command === "--help" || command === "help") {
  usage();
} else if (command === "init") {
  initWiki(root, args);
} else if (command === "build") {
  buildSite(root);
} else if (command === "health") {
  health(root);
} else if (command === "serve") {
  serve(root, Number(args.port || 4173));
} else if (command === "connect") {
  connect(root, args._[1]);
} else if (command === "update") {
  update(root, args);
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exitCode = 1;
}
