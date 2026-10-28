"use strict";
// DB Editor — dependency-free UI.

const S = {
  session: null, containers: [], openCt: new Set(), dbId: null, schema: null, db: null,
  table: null, view: "data", page: 1, size: 50, sort: null, desc: false, q: "", col: "",
  data: null, backupAsked: new Set(),
};

// ------------------------------------------------------------------ i18n
// English is the source language: every string is written in English and is also its key in
// static/i18n/<lang>.json. Missing keys fall back to English. Server errors come with the
// English template in `key` and its values in `params`, so they are translated the same way.
const LANGS = { en: "English", es: "Español", zh: "中文", fr: "Français", de: "Deutsch", pt: "Português" };
let LANG = "en", L = {};

function t(s, params) {
  const out = L[s] ?? s;
  if (!params) return out;
  return out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? (typeof params[k] === "string" ? L[params[k]] ?? params[k] : params[k]) : m));
}
// Like t(), but placeholders can be DOM nodes: returns an array for el().
const tn = (s, nodes) => t(s).split(/\{(\w+)\}/).map((p, i) => (i % 2 ? nodes[p] ?? `{${p}}` : p));

function pickLang() {
  try { const saved = localStorage.getItem("dbe-lang"); if (LANGS[saved]) return saved; } catch { /* no storage */ }
  for (const l of navigator.languages || [navigator.language]) {
    const base = String(l || "").slice(0, 2).toLowerCase();
    if (LANGS[base]) return base;
  }
  return "en";
}

async function setLang(lang) {
  let dict = {};
  if (lang !== "en") {
    try { dict = await (await fetch(`/static/i18n/${lang}.json`)).json(); } catch { lang = "en"; }
  }
  LANG = lang; L = dict;
  try { localStorage.setItem("dbe-lang", lang); } catch { /* no storage */ }
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll("[data-i18n]")) n.textContent = t(n.dataset.i18n);
  for (const n of document.querySelectorAll("[data-i18n-title]")) n.title = t(n.dataset.i18nTitle);
  for (const n of document.querySelectorAll("[data-i18n-placeholder]")) n.placeholder = t(n.dataset.i18nPlaceholder);
  for (const n of document.querySelectorAll(".lang-select")) n.value = lang;
}

for (const sel of document.querySelectorAll(".lang-select")) {
  sel.append(...Object.entries(LANGS).map(([code, name]) => new Option(name, code)));
  sel.addEventListener("change", async () => {
    await setLang(sel.value);
    if (!$("app").classList.contains("hidden")) { renderSidebar(); renderMain(); }
  });
}

// ------------------------------------------------------------------ utilities
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false)
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
}
function $(id) { return document.getElementById(id); }

async function api(method, url, body) {
  const opts = { method, headers: { "X-DBE": "1" }, credentials: "same-origin" };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* no body */ }
  if (r.status === 401 && !url.endsWith("/login")) { showLogin(); throw new Error(t("Session expired")); }
  if (!r.ok) throw new Error(data && data.error ? t(data.key || data.error, data.params) : t("Error {status}", { status: r.status }));
  return data;
}

let toastTimer;
function toast(msg, kind = "") {
  const box = $("toast"); box.textContent = msg; box.className = "toast " + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.add("hidden"), 4500);
}
function fmtSize(b) {
  if (b === null || b === undefined) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (d) => d.toLocaleString(LANG, { dateStyle: "short", timeStyle: "medium" });

// ------------------------------------------------------------------ modal
function closeModal() { $("modal").classList.add("hidden"); $("modal-box").replaceChildren(); }
function openModal(title, body, buttons, extraHead) {
  const box = $("modal-box");
  box.replaceChildren(
    el("div", { class: "modal-head" }, el("h3", {}, title), extraHead || null,
      el("button", { onclick: closeModal, title: t("Close") }, "✕")),
    el("div", { class: "modal-body" }, body),
    el("div", { class: "modal-foot" }, buttons));
  $("modal").classList.remove("hidden");
}
$("modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function choose(title, text, options) {
  return new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    openModal(title, el("div", {}, text),
      options.map((o) => el("button", { class: o.cls || "", onclick: () => done(o.value) }, o.label)));
    $("modal").addEventListener("mousedown", function h(e) {
      if (e.target.id === "modal") { $("modal").removeEventListener("mousedown", h); resolve(null); }
    });
  });
}

// ------------------------------------------------------------------ format detection
const DATE_NAME = /(date|time|_at$|^at$|_ts$|^ts$|stamp|created|updated|modified|expire|last_|_until|since|deadline|birthday|joined|seen)/i;
const BOOL_NAME = /^(is_|has_|can_|should_|allow)|(enabled|disabled|active|banned|admin|blocked|muted|verified|deleted|done|paid|premium|notify|flag)$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function epochToDate(n, column) {
  if (typeof n !== "number" || !(DATE_NAME.test(column.name) || /DATE|TIME/i.test(column.type))) return null;
  if (n >= 946684800 && n <= 4102444800) return new Date(n * 1000);            // seconds
  if (n >= 946684800000 && n <= 4102444800000) return new Date(n);             // milliseconds
  return null;
}
function isoToDate(s) {
  if (typeof s !== "string" || !ISO_RE.test(s)) return null;
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s.replace(" ", "T"));
  return isNaN(d) ? null : { d, hasTz };
}
function parseJson(s) {
  if (typeof s !== "string") return undefined;
  const v = s.trim();
  if (!((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]")))) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}
const isBlob = (v) => v && typeof v === "object" && "$blob" in v;
const isBig = (v) => v && typeof v === "object" && ("$int" in v || "$real" in v);

function formatCell(v, column) {
  if (v === null) return { text: "NULL", cls: "v-null" };
  if (isBlob(v)) return { text: `BLOB ${fmtSize(v.size)}`, cls: "v-blob" };
  if (isBig(v)) return { text: v.$int ?? v.$real, cls: "v-num" };
  if (typeof v === "number") {
    const d = epochToDate(v, column);
    if (d) return { text: fmtDate(d), cls: "v-date", title: `${v} (epoch)` };
    if ((v === 0 || v === 1) && BOOL_NAME.test(column.name)) return { text: v ? "✓ 1" : "✗ 0", cls: `v-bool-${v}` };
    return { text: String(v), cls: "v-num" };
  }
  const iso = isoToDate(v);
  if (iso) {
    const shown = iso.hasTz ? fmtDate(iso.d) : v.replace("T", " ").replace(/\.\d+$/, "");
    return { text: shown, cls: "v-date", title: v + (iso.hasTz ? "" : " " + t("(no time zone)")) };
  }
  const j = parseJson(v);
  if (j !== undefined) {
    const keys = Array.isArray(j) ? `[${j.length}]` : `{${Object.keys(j).length}}`;
    return { text: `${keys} ${v.length > 120 ? v.slice(0, 120) + "…" : v}`, cls: "v-json", title: JSON.stringify(j, null, 2).slice(0, 2000) };
  }
  return { text: v.length > 200 ? v.slice(0, 200) + "…" : v, title: v.length > 40 ? v.slice(0, 2000) : null };
}

// ------------------------------------------------------------------ login / startup
function showLogin() {
  $("app").classList.add("hidden"); $("login").classList.remove("hidden");
  $("login-password").focus();
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault(); $("login-error").textContent = "";
  try {
    await api("POST", "/api/login", { password: $("login-password").value });
    $("login-password").value = ""; start();
  } catch (err) { $("login-error").textContent = err.message; }
});
$("btn-logout").addEventListener("click", async () => { await api("POST", "/api/logout"); showLogin(); });
$("btn-refresh").addEventListener("click", () => loadContainers(true));

async function start() {
  S.session = await api("GET", "/api/session");
  if (!S.session.authenticated) return showLogin();
  $("login").classList.add("hidden"); $("app").classList.remove("hidden");
  $("ro-badge").classList.toggle("hidden", !S.session.read_only);
  checkUpdate();
  await loadContainers(false);
}

// Only tells the user about a newer version on GitHub; updating is up to them.
async function checkUpdate() {
  let v;
  try { v = await api("GET", "/api/version"); } catch { return; }
  $("update-badge").classList.toggle("hidden", !v.update_available);
  $("update-badge").onclick = () => openModal(t("Update available"), el("div", {},
    el("p", {}, t("Version {latest} is available (you have {current}).", v)),
    el("p", {}, t("This app does not update itself. To update, run this in the folder where you cloned the repository:")),
    el("pre", { class: "sql" }, "git pull\ndocker compose up -d --build"),
    el("p", {}, el("a", { href: v.url, target: "_blank", rel: "noopener" }, t("View on GitHub")))),
    [el("div", { class: "spacer" }), el("button", { onclick: closeModal }, t("Close"))]);
}

// ------------------------------------------------------------------ sidebar
async function loadContainers(force) {
  try {
    const r = await api("GET", "/api/containers" + (force ? "?refresh=1" : ""));
    S.containers = r.containers; S.hostRoot = r.host_root;
    if (r.error) toast(t(r.error), "bad");
    if (!S.openCt.size) S.containers.filter((c) => c.databases.length).forEach((c) => S.openCt.add(c.name));
    renderSidebar();
    if (force) toast(t("Containers refreshed"), "good");
  } catch (err) { toast(err.message, "bad"); }
}

const hiddenMounts = (c) => c.mounts.filter((m) => !m.accessible);
const mountWarnings = (c) => hiddenMounts(c).map((m) =>
  el("div", { class: "mount-warn", title: t("In the container: {path}", { path: m.destination }) }, t("⚠ Not accessible: {path}", { path: m.source })));

function renderContainer(c) {
  const open = S.openCt.has(c.name);
  const hidden = hiddenMounts(c);
  const head = el("div", { class: "ct-head", onclick: () => { open ? S.openCt.delete(c.name) : S.openCt.add(c.name); renderSidebar(); } },
    el("span", {}, open ? "▾" : "▸"), el("span", { class: "ct-name", title: c.image }, c.name),
    el("span", { class: "badge info" }, c.databases.length),
    hidden.length ? el("span", { class: "badge warn", title: t("Mounts not visible to the viewer") }, "!") : null);
  const body = open ? el("div", { class: "ct-body" },
    c.databases.map((d) => [
      el("div", { class: "db-item" + (d.id === S.dbId ? " active" : ""), title: `${d.path}\n${t("In the container: {path}", { path: d.container_path })}`, onclick: () => openDb(d, c.name) },
        "🗄", el("span", { class: "n" }, d.name), el("span", { class: "muted" }, fmtSize(d.size))),
      d.id === S.dbId && S.schema ? S.schema.tables.map((tb) =>
        el("div", { class: "tbl-item" + (tb.name === S.table ? " active" : ""), onclick: () => openTable(tb.name) },
          el("span", { class: "n" }, tb.name),
          tb.type !== "table" ? el("span", { class: "badge" }, tb.type) : !tb.editable ? el("span", { class: "badge", title: t(tb.readonly_reason) }, "ro") : null)) : null,
    ]),
    mountWarnings(c)) : null;
  return el("div", { class: "ct" }, head, body);
}

function renderSidebar() {
  const side = $("sidebar");
  if (!S.containers.length) { side.replaceChildren(el("div", { class: "muted pad" }, t("No running containers."))); return; }
  const withDb = S.containers.filter((c) => c.databases.length);
  const noDb = S.containers.filter((c) => !c.databases.length);
  const anyHidden = S.containers.some((c) => hiddenMounts(c).length);
  const group = noDb.length ? el("div", { class: "group" },
    el("div", { class: "group-head", onclick: () => { S.showNoDb = !S.showNoDb; renderSidebar(); } },
      el("span", {}, S.showNoDb ? "▾" : "▸"), el("span", { class: "ct-name" }, t("No databases")),
      el("span", { class: "badge" }, noDb.length)),
    S.showNoDb ? noDb.map((c) => el("div", { class: "nodb-item" },
      el("div", { class: "n", title: c.image }, c.name), mountWarnings(c))) : null) : null;
  side.replaceChildren(...[
    anyHidden && !S.hostRoot ? el("div", { class: "hint-box" },
      tn("Some mounts are not visible to the viewer. Mount the host root with {mount} (see docker-compose.yml) and press ⟳ Scan.",
        { mount: el("code", {}, "- /:/host:rslave") })) : null,
    withDb.length ? withDb.map((c) => renderContainer(c)) : el("div", { class: "muted pad" }, t("No container uses SQLite.")),
    group].flat().filter(Boolean));
}

// ------------------------------------------------------------------ database / table
async function openDb(d, ctName) {
  S.dbId = d.id; S.db = { ...d, container: ctName }; S.schema = null; S.table = null; S.view = "data";
  renderSidebar();
  try {
    S.schema = await api("GET", `/api/db/${d.id}`);
  } catch (err) { toast(err.message, "bad"); return; }
  renderSidebar();
  const first = S.schema.tables.find((tb) => tb.editable) || S.schema.tables.find((tb) => tb.type === "table" && !tb.name.startsWith("sqlite_")) || S.schema.tables[0];
  if (first) openTable(first.name); else renderMain();
}
const curTable = () => S.schema && S.schema.tables.find((tb) => tb.name === S.table);

function openTable(name) {
  S.table = name; S.page = 1; S.sort = null; S.desc = false; S.q = ""; S.col = "";
  if (S.view === "sql") S.view = "data";
  renderSidebar(); loadRows();
}

async function loadRows() {
  const p = new URLSearchParams({ table: S.table, page: S.page, size: S.size });
  if (S.sort) { p.set("sort", S.sort); if (S.desc) p.set("desc", "1"); }
  if (S.q) { p.set("q", S.q); if (S.col) p.set("col", S.col); }
  try {
    S.data = await api("GET", `/api/db/${S.dbId}/rows?${p}`);
  } catch (err) { S.data = null; toast(err.message, "bad"); }
  renderMain();
}

function renderMain() {
  const main = $("main");
  const tb = curTable();
  $("crumbs").textContent = [S.db && S.db.container, S.db && S.db.name, S.table].filter(Boolean).join(" › ");
  if (!S.schema) { main.replaceChildren(el("div", { class: "empty" }, t("Choose a database in the left panel."))); return; }

  const sch = S.schema;
  const info = el("div", { class: "dbinfo" },
    el("span", {}, t("Path:"), " ", el("code", {}, sch.path)),
    el("span", {}, "journal: ", el("code", {}, sch.journal_mode)),
    sch.alembic ? el("span", { class: "badge warn" }, t("Alembic {version} · schema locked", { version: sch.alembic_version ? sch.alembic_version.join(",") : "" })) : null,
    !sch.alembic && sch.schema_locked ? el("span", { class: "badge" }, t("schema locked")) : null,
    !sch.mount_rw ? el("span", { class: "badge warn" }, t("mounted :ro in the container")) : null,
    el("span", {}, t("backups: {n}", { n: sch.backups.length }),
      sch.backups[0] ? " " + t("(latest {date})", { date: fmtDate(new Date(sch.backups[0].mtime * 1000)) }) : ""));

  const tabs = el("div", { class: "tabs" },
    el("button", { class: S.view === "data" ? "on" : "", onclick: () => { S.view = "data"; renderMain(); }, disabled: !tb }, t("Data")),
    el("button", { class: S.view === "schema" ? "on" : "", onclick: () => { S.view = "schema"; renderMain(); }, disabled: !tb }, t("Schema")),
    S.session.sql_console ? el("button", { class: S.view === "sql" ? "on" : "", onclick: () => { S.view = "sql"; renderMain(); } }, "SQL") : null);

  const backupBtn = el("button", { onclick: doBackup, disabled: S.session.read_only, title: t("Backup with the SQLite backup API") }, "💾 " + t("Backup"));

  if (S.view === "sql") { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, S.db.name), tabs, el("div", { class: "spacer" }), backupBtn), info, renderConsole()); return; }
  if (!tb) { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, S.db.name), tabs, el("div", { class: "spacer" }), backupBtn), info, el("div", { class: "empty" }, t("The database has no tables."))); return; }
  if (S.view === "schema") { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, tb.name), tabs, el("div", { class: "spacer" }), backupBtn), info, renderSchema(tb)); return; }

  // --- data view
  const search = el("input", { type: "search", placeholder: t("Filter…"), value: S.q });
  let deb;
  search.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => { S.q = search.value; S.page = 1; loadRows(); }, 350); });
  const colSel = el("select", { onchange: (e) => { S.col = e.target.value; S.page = 1; if (S.q) loadRows(); } },
    el("option", { value: "" }, t("all columns")),
    tb.columns.map((c) => el("option", { value: c.name, selected: c.name === S.col }, c.name)));
  const toolbar = el("div", { class: "toolbar" },
    el("h2", {}, tb.name), tabs, search, colSel, el("div", { class: "spacer" }),
    !tb.editable ? el("span", { class: "badge", title: t(tb.readonly_reason) }, t("read-only")) : null,
    el("button", { class: "primary", disabled: !tb.editable, onclick: () => openEditor(tb, null) }, "+ " + t("Insert")),
    backupBtn);

  const d = S.data;
  if (!d || d.table.name !== tb.name) { main.replaceChildren(toolbar, info, el("div", { class: "empty" }, d ? t("Loading…") : t("Could not read the data."))); return; }
  const cols = d.table.columns;
  const thead = el("tr", {}, cols.map((c) => el("th", {
    onclick: () => { if (S.sort === c.name) S.desc = !S.desc; else { S.sort = c.name; S.desc = false; } loadRows(); },
  }, c.name, c.pk ? el("span", { class: "pk", title: t("Primary key") }, "🔑") : null,
    el("span", { class: "t" }, c.type || ""), S.sort === c.name ? (S.desc ? " ▼" : " ▲") : "")));
  const tbody = el("tbody", {}, d.rows.map((r) => el("tr", { onclick: () => openEditor(d.table, r) },
    r.values.map((v, i) => { const f = formatCell(v, cols[i]); return el("td", { class: f.cls || "", title: f.title || null }, f.text); }))));
  const grid = el("div", { class: "grid-wrap" }, d.rows.length
    ? el("table", { class: "grid" }, el("thead", {}, thead), tbody)
    : el("div", { class: "empty pad" }, S.q ? t("No row matches the filter.") : t("Empty table.")));

  const pages = d.total === null ? null : Math.max(1, Math.ceil(d.total / d.size));
  const sizeSel = el("select", { onchange: (e) => { S.size = +e.target.value; S.page = 1; loadRows(); } },
    [25, 50, 100, 250, 500].map((n) => el("option", { value: n, selected: n === S.size }, t("{n} / page", { n }))));
  const pager = el("div", { class: "pager" },
    el("button", { disabled: S.page <= 1, onclick: () => { S.page = 1; loadRows(); } }, "«"),
    el("button", { disabled: S.page <= 1, onclick: () => { S.page--; loadRows(); } }, "‹"),
    el("span", {}, pages ? t("Page {page} of {pages}", { page: S.page, pages }) : t("Page {page}", { page: S.page })),
    el("button", { disabled: pages ? S.page >= pages : d.rows.length < d.size, onclick: () => { S.page++; loadRows(); } }, "›"),
    pages ? el("button", { disabled: S.page >= pages, onclick: () => { S.page = pages; loadRows(); } }, "»") : null,
    el("span", { class: "muted" }, d.total === null ? t("(too many rows to count)") : t("{n} rows", { n: d.total })),
    el("div", { class: "spacer" }), sizeSel,
    el("button", { onclick: loadRows, title: t("Reload") }, "⟳"));
  main.replaceChildren(toolbar, info, grid, pager);
}

function renderSchema(tb) {
  const cols = el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, ["#", t("Column"), t("Type"), t("Affinity"), "NOT NULL", t("Default"), "PK"].map((h) => el("th", {}, h)))),
    el("tbody", {}, tb.columns.map((c, i) => el("tr", {}, el("td", {}, i), el("td", {}, c.name), el("td", {}, c.type),
      el("td", {}, c.affinity), el("td", {}, c.notnull ? t("yes") : ""), el("td", {}, c.default ?? ""), el("td", {}, c.pk || "")))));
  return el("div", { class: "schema" },
    el("div", {}, el("h3", {}, t("Row identification")),
      tb.key ? el("div", {}, tb.key.kind === "pk" ? t("Primary key: {columns}", { columns: tb.key.columns.join(", ") }) : t("No primary key: rowid is used"))
        : el("div", { class: "muted" }, t("Not available")),
      !tb.editable ? el("div", { class: "muted" }, t("Read-only: {reason}", { reason: tb.readonly_reason })) : null),
    el("div", {}, el("h3", {}, t("Columns")), cols),
    tb.indexes && tb.indexes.length ? el("div", {}, el("h3", {}, t("Indexes")), el("ul", {}, tb.indexes.map((i) =>
      el("li", {}, el("code", {}, i.name), ` (${i.columns.join(", ")})`, i.unique ? " UNIQUE" : "", i.partial ? " " + t("partial") : "", ` · ${i.origin}`)))) : null,
    tb.foreign_keys && tb.foreign_keys.length ? el("div", {}, el("h3", {}, t("Foreign keys")), el("ul", {}, tb.foreign_keys.map((f) =>
      el("li", {}, el("code", {}, f.from), " → ", el("code", {}, `${f.table}(${f.to ?? "PK"})`), ` ON DELETE ${f.on_delete} ON UPDATE ${f.on_update}`)))) : null,
    el("div", {}, el("h3", {}, "SQL"), el("pre", { class: "sql" }, tb.sql || "")));
}

// ------------------------------------------------------------------ backups
async function doBackup() {
  try {
    const r = await api("POST", `/api/db/${S.dbId}/backup`);
    S.backupAsked.add(S.dbId);
    toast(t("Backup created: {file} ({size})", { file: r.file, size: fmtSize(r.size) }), "good");
    S.schema = { ...S.schema, ...(await api("GET", `/api/db/${S.dbId}`)) };
    renderMain();
    return true;
  } catch (err) { toast(t("Could not create the backup: {error}", { error: err.message }), "bad"); return false; }
}

async function ensureBackup() {
  if (S.backupAsked.has(S.dbId)) return true;
  const choice = await choose(t("Back up before writing?"),
    el("div", {}, el("p", {}, tn("You are about to modify {path}.", { path: el("code", {}, S.db.path) })),
      el("p", { class: "muted" }, t("Creating a backup with the SQLite backup API is recommended. You are only asked once per database in this session."))),
    [{ label: t("Cancel"), value: null }, { label: t("Continue without backup"), value: "skip" },
     { label: t("Create backup and continue"), value: "backup", cls: "primary" }]);
  if (!choice) return false;
  if (choice === "skip") { S.backupAsked.add(S.dbId); return true; }
  return doBackup();
}

// ------------------------------------------------------------------ row editor
function toEditText(v) {
  if (v === null) return "";
  if (isBig(v)) return v.$int ?? v.$real;
  return String(v);
}

function fromEditText(text, column, original) {
  const intRe = /^-?\d+$/, numRe = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  let aff = column.affinity;
  if (aff === "BLOB") aff = typeof original === "number" || isBig(original) ? "NUMERIC" : "TEXT";
  const s = text.trim();
  if (aff === "INTEGER" || aff === "NUMERIC") {
    if (intRe.test(s)) return { $int: s };
    if (numRe.test(s)) return Number(s);
  }
  if (aff === "REAL" && numRe.test(s)) return Number(s);
  return text;
}

function dateHint(text, column) {
  const n = Number(text);
  if (text.trim() !== "" && !isNaN(n)) { const d = epochToDate(n, column); if (d) return `→ ${fmtDate(d)} (epoch ${n > 1e11 ? "ms" : "s"})`; }
  const iso = isoToDate(text.trim());
  if (iso) return `→ ${fmtDate(iso.d)}${iso.hasTz ? "" : " " + t("(time without zone, read as local)")}`;
  return null;
}

function nowLike(text, column) {
  const n = Number(text);
  if (text.trim() !== "" && !isNaN(n)) return n > 1e11 ? String(Date.now()) : (/\./.test(text) ? (Date.now() / 1000).toFixed(3) : String(Math.floor(Date.now() / 1000)));
  if (/Z|[+-]\d{2}:?\d{2}$/.test(text)) return new Date().toISOString();
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  const sep = text.includes("T") ? "T" : " ";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}${sep}${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openEditor(table, row) {
  const isNew = row === null;
  const editable = table.editable && !S.session.read_only;
  const fields = table.columns.map((c, i) => {
    const orig = isNew ? null : row.values[i];
    const blob = isBlob(orig);
    const text = toEditText(orig);
    const json = parseJson(text) !== undefined;
    const isDate = !blob && (DATE_NAME.test(c.name) || /DATE|TIME/i.test(c.type) || isoToDate(text));
    const multiline = json || text.length > 80 || text.includes("\n");
    const input = multiline
      ? el("textarea", { rows: Math.min(14, Math.max(3, text.split("\n").length + 1)) })
      : el("input", { type: "text" });
    input.value = blob ? t("BLOB of {size} (not editable)", { size: fmtSize(orig.size) }) : text;
    input.disabled = !editable || blob;
    const hint = el("div", { class: "hint" });
    const nullCb = el("input", { type: "checkbox" });
    nullCb.checked = isNew ? true : orig === null;
    nullCb.disabled = !editable || blob;
    const nullLabel = el("label", { class: "nullbox" }, nullCb, isNew ? t("default") : "NULL");
    const update = () => {
      input.disabled = !editable || blob || nullCb.checked;
      if (nullCb.checked) { hint.textContent = isNew ? (c.default !== null ? t("Default: {value}", { value: c.default }) : c.pk ? t("Auto / NULL") : "NULL") : ""; hint.className = "hint"; return; }
      const v = input.value;
      const j = parseJson(v);
      if (j !== undefined) { hint.textContent = t("Valid JSON"); hint.className = "hint"; }
      else if (json && v.trim()) { hint.textContent = t("Invalid JSON"); hint.className = "hint bad"; }
      else { hint.textContent = isDate ? (dateHint(v, c) || "") : ""; hint.className = "hint"; }
    };
    input.addEventListener("input", () => { if (nullCb.checked && isNew) nullCb.checked = false; update(); });
    nullCb.addEventListener("change", update);
    update();
    const tools = [];
    if (editable && json) tools.push(el("button", { type: "button", onclick: () => {
      const j = parseJson(input.value); if (j === undefined) return;
      const pretty = !input.value.includes("\n");
      input.value = pretty ? JSON.stringify(j, null, 2) : JSON.stringify(j);
      input.rows = Math.min(14, input.value.split("\n").length + 1); update();
    }, title: t("Beware: very large integers inside the JSON may lose precision") }, t("Format/compact JSON")));
    if (editable && isDate && !blob) tools.push(el("button", { type: "button", onclick: () => { nullCb.checked = false; input.value = nowLike(input.value, c); update(); } }, t("Now")));
    const field = el("div", { class: "field" },
      el("label", {}, c.name, el("span", { class: "muted" }, `${c.type || t("no type")}${c.pk ? " · PK" : ""}${c.notnull ? " · NOT NULL" : ""}`)),
      el("div", { class: "row" }, input, nullLabel), hint,
      tools.length ? el("div", { class: "tools" }, tools) : null);
    return { c, orig, input, nullCb, blob, initial: { text, isNull: orig === null }, field };
  });

  const collect = () => {
    const values = {};
    for (const f of fields) {
      if (f.blob) continue;
      if (isNew) {
        if (!f.nullCb.checked) values[f.c.name] = fromEditText(f.input.value, f.c, null);
        continue;
      }
      const isNull = f.nullCb.checked;
      if (isNull === f.initial.isNull && (isNull || f.input.value === f.initial.text)) continue; // unchanged
      values[f.c.name] = isNull ? null : fromEditText(f.input.value, f.c, f.orig);
    }
    return values;
  };

  const save = async () => {
    const values = collect();
    if (!isNew && !Object.keys(values).length) { closeModal(); return; }
    const payload = { table: table.name, values };
    if (!isNew) payload.key = row.key;
    if (!(await ensureBackup())) return;
    try {
      await api("POST", `/api/db/${S.dbId}/${isNew ? "insert" : "update"}`, payload);
      closeModal(); toast(isNew ? t("Row inserted") : t("Row saved"), "good"); loadRows();
    } catch (err) { toast(err.message, "bad"); }
  };

  const del = async () => {
    const ok = await choose(t("Delete row"), t("Are you sure you want to delete this row? This cannot be undone (except from a backup)."),
      [{ label: t("Cancel"), value: false }, { label: t("Delete"), value: true, cls: "danger solid" }]);
    if (!ok) { openEditor(table, row); return; }
    if (!(await ensureBackup())) return;
    try {
      await api("POST", `/api/db/${S.dbId}/delete`, { table: table.name, key: row.key });
      toast(t("Row deleted"), "good"); loadRows();
    } catch (err) { toast(err.message, "bad"); }
  };

  const keyDesc = row && table.key ? table.key.columns.map((k, i) => `${k}=${toEditText(row.key[i])}`).join(", ") : "";
  const buttons = editable
    ? [!isNew ? el("button", { class: "danger", onclick: del }, t("Delete")) : null, el("div", { class: "spacer" }),
       el("button", { onclick: closeModal }, t("Cancel")), el("button", { class: "primary", onclick: save }, isNew ? t("Insert") : t("Save"))]
    : [el("span", { class: "muted" }, t(table.readonly_reason || "Read-only")), el("div", { class: "spacer" }), el("button", { onclick: closeModal }, t("Close"))];
  openModal(isNew ? t("Insert into {table}", { table: table.name }) : `${table.name} · ${keyDesc}`, fields.map((f) => f.field), buttons);
}

// ------------------------------------------------------------------ SQL console
function renderConsole() {
  const ta = el("textarea", { placeholder: "SELECT * FROM … LIMIT 100", spellcheck: "false" });
  ta.value = S.lastSql || "";
  const out = el("div", { class: "result" }, el("div", { class: "muted pad" },
    t("One statement per run. Statements that write ask for confirmation; schema changes are blocked unless ALLOW_SCHEMA_CHANGES is set (and always for Alembic databases).")));
  const run = async (confirm = false) => {
    S.lastSql = ta.value;
    try {
      const r = await api("POST", `/api/db/${S.dbId}/sql`, { sql: ta.value, confirm });
      if (r.needs_confirm) {
        const ok = await choose(t("Write statement"), el("div", {},
          el("p", {}, r.ddl ? t("This statement CHANGES THE DATABASE SCHEMA.") : t("This statement modifies data.")),
          el("pre", { class: "sql" }, ta.value)),
          [{ label: t("Cancel"), value: false }, { label: t("Run"), value: true, cls: "danger solid" }]);
        if (ok && (await ensureBackup())) return run(true);
        return;
      }
      if (!r.columns.length) { out.replaceChildren(el("div", { class: "pad" }, r.wrote ? t("Done. Rows affected: {n}", { n: r.changes }) : t("No results."))); }
      else {
        const cols = r.columns.map((n) => ({ name: n, type: "" }));
        out.replaceChildren(el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, r.columns.map((n) => el("th", {}, n)))),
          el("tbody", {}, r.rows.map((row) => el("tr", {}, row.map((v, i) => { const f = formatCell(v, cols[i]); return el("td", { class: f.cls || "", title: f.title || null }, f.text); }))))),
          r.truncated ? el("div", { class: "muted pad" }, t("Result truncated.")) : null);
      }
      if (r.wrote) toast(t("Write completed ({n} rows)", { n: r.changes }), "good");
    } catch (err) { out.replaceChildren(el("div", { class: "pad error" }, err.message)); }
  };
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
  return el("div", { class: "console" }, ta,
    el("div", { class: "row", style: "display:flex;gap:8px" }, el("button", { class: "primary", onclick: () => run() }, t("Run (Ctrl+Enter)"))), out);
}

setLang(pickLang()).finally(() => start().catch(() => showLogin()));
