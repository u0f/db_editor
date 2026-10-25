"use strict";
// DB Editor — interfaz sin dependencias.

const S = {
  session: null, containers: [], openCt: new Set(), dbId: null, schema: null, db: null,
  table: null, view: "data", page: 1, size: 50, sort: null, desc: false, q: "", col: "",
  data: null, backupAsked: new Set(),
};

// ------------------------------------------------------------------ utilidades
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
const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const opts = { method, headers: { "X-DBE": "1" }, credentials: "same-origin" };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (r.status === 401 && !url.endsWith("/login")) { showLogin(); throw new Error("Sesión caducada"); }
  if (!r.ok) throw new Error((data && data.error) || `Error ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("toast"); t.textContent = msg; t.className = "toast " + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}
function fmtSize(b) {
  if (b === null || b === undefined) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
const fmtDate = (d) => d.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "medium" });

// ------------------------------------------------------------------ modal
function closeModal() { $("modal").classList.add("hidden"); $("modal-box").replaceChildren(); }
function openModal(title, body, buttons, extraHead) {
  const box = $("modal-box");
  box.replaceChildren(
    el("div", { class: "modal-head" }, el("h3", {}, title), extraHead || null,
      el("button", { onclick: closeModal, title: "Cerrar" }, "✕")),
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

// ------------------------------------------------------------------ detección de formatos
const DATE_NAME = /(date|time|_at$|^at$|_ts$|^ts$|stamp|created|updated|modified|expire|last_|_until|since|deadline|birthday|joined|seen)/i;
const BOOL_NAME = /^(is_|has_|can_|should_|allow)|(enabled|disabled|active|banned|admin|blocked|muted|verified|deleted|done|paid|premium|notify|flag)$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function epochToDate(n, column) {
  if (typeof n !== "number" || !(DATE_NAME.test(column.name) || /DATE|TIME/i.test(column.type))) return null;
  if (n >= 946684800 && n <= 4102444800) return new Date(n * 1000);            // segundos
  if (n >= 946684800000 && n <= 4102444800000) return new Date(n);             // milisegundos
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
  const t = s.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
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
    return { text: shown, cls: "v-date", title: v + (iso.hasTz ? "" : " (sin zona horaria)") };
  }
  const j = parseJson(v);
  if (j !== undefined) {
    const keys = Array.isArray(j) ? `[${j.length}]` : `{${Object.keys(j).length}}`;
    return { text: `${keys} ${v.length > 120 ? v.slice(0, 120) + "…" : v}`, cls: "v-json", title: JSON.stringify(j, null, 2).slice(0, 2000) };
  }
  return { text: v.length > 200 ? v.slice(0, 200) + "…" : v, title: v.length > 40 ? v.slice(0, 2000) : null };
}

// ------------------------------------------------------------------ login / arranque
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
  await loadContainers(false);
}

// ------------------------------------------------------------------ barra lateral
async function loadContainers(force) {
  try {
    const r = await api("GET", "/api/containers" + (force ? "?refresh=1" : ""));
    S.containers = r.containers; S.hostRoot = r.host_root;
    if (r.error) toast(r.error, "bad");
    if (!S.openCt.size) S.containers.filter((c) => c.databases.length).forEach((c) => S.openCt.add(c.name));
    renderSidebar();
    if (force) toast("Contenedores actualizados", "good");
  } catch (err) { toast(err.message, "bad"); }
}

const hiddenMounts = (c) => c.mounts.filter((m) => !m.accessible);
const mountWarnings = (c) => hiddenMounts(c).map((m) =>
  el("div", { class: "mount-warn", title: `En el contenedor: ${m.destination}` }, `⚠ No accesible: ${m.source}`));

function renderContainer(c) {
  const open = S.openCt.has(c.name);
  const hidden = hiddenMounts(c);
  const head = el("div", { class: "ct-head", onclick: () => { open ? S.openCt.delete(c.name) : S.openCt.add(c.name); renderSidebar(); } },
    el("span", {}, open ? "▾" : "▸"), el("span", { class: "ct-name", title: c.image }, c.name),
    el("span", { class: "badge info" }, c.databases.length),
    hidden.length ? el("span", { class: "badge warn", title: "Montajes no visibles desde el visor" }, "!") : null);
  const body = open ? el("div", { class: "ct-body" },
    c.databases.map((d) => [
      el("div", { class: "db-item" + (d.id === S.dbId ? " active" : ""), title: `${d.path}\nEn el contenedor: ${d.container_path}`, onclick: () => openDb(d, c.name) },
        "🗄", el("span", { class: "n" }, d.name), el("span", { class: "muted" }, fmtSize(d.size))),
      d.id === S.dbId && S.schema ? S.schema.tables.map((t) =>
        el("div", { class: "tbl-item" + (t.name === S.table ? " active" : ""), onclick: () => openTable(t.name) },
          el("span", { class: "n" }, t.name),
          t.type !== "table" ? el("span", { class: "badge" }, t.type) : !t.editable ? el("span", { class: "badge", title: t.readonly_reason }, "ro") : null)) : null,
    ]),
    mountWarnings(c)) : null;
  return el("div", { class: "ct" }, head, body);
}

function renderSidebar() {
  const side = $("sidebar");
  if (!S.containers.length) { side.replaceChildren(el("div", { class: "muted pad" }, "No hay contenedores en marcha.")); return; }
  const withDb = S.containers.filter((c) => c.databases.length);
  const noDb = S.containers.filter((c) => !c.databases.length);
  const anyHidden = S.containers.some((c) => hiddenMounts(c).length);
  const group = noDb.length ? el("div", { class: "group" },
    el("div", { class: "group-head", onclick: () => { S.showNoDb = !S.showNoDb; renderSidebar(); } },
      el("span", {}, S.showNoDb ? "▾" : "▸"), el("span", { class: "ct-name" }, "Sin bases de datos"),
      el("span", { class: "badge" }, noDb.length)),
    S.showNoDb ? noDb.map((c) => el("div", { class: "nodb-item" },
      el("div", { class: "n", title: c.image }, c.name), mountWarnings(c))) : null) : null;
  side.replaceChildren(...[
    anyHidden && !S.hostRoot ? el("div", { class: "hint-box" }, "Hay montajes que el visor no ve. Monta la raíz del host con ",
      el("code", {}, "- /:/host:rslave"), " (ver docker-compose.yml) y pulsa ⟳ Buscar.") : null,
    withDb.length ? withDb.map((c) => renderContainer(c)) : el("div", { class: "muted pad" }, "Ningún contenedor usa SQLite."),
    group].flat().filter(Boolean));
}

// ------------------------------------------------------------------ base de datos / tabla
async function openDb(d, ctName) {
  S.dbId = d.id; S.db = { ...d, container: ctName }; S.schema = null; S.table = null; S.view = "data";
  renderSidebar();
  try {
    S.schema = await api("GET", `/api/db/${d.id}`);
  } catch (err) { toast(err.message, "bad"); return; }
  renderSidebar();
  const first = S.schema.tables.find((t) => t.editable) || S.schema.tables.find((t) => t.type === "table" && !t.name.startsWith("sqlite_")) || S.schema.tables[0];
  if (first) openTable(first.name); else renderMain();
}
const curTable = () => S.schema && S.schema.tables.find((t) => t.name === S.table);

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
  const t = curTable();
  $("crumbs").textContent = [S.db && S.db.container, S.db && S.db.name, S.table].filter(Boolean).join(" › ");
  if (!S.schema) { main.replaceChildren(el("div", { class: "empty" }, "Elige una base de datos en el panel izquierdo.")); return; }

  const sch = S.schema;
  const info = el("div", { class: "dbinfo" },
    el("span", {}, "Ruta: ", el("code", {}, sch.path)),
    el("span", {}, "journal: ", el("code", {}, sch.journal_mode)),
    sch.alembic ? el("span", { class: "badge warn" }, `Alembic ${sch.alembic_version ? sch.alembic_version.join(",") : ""} · estructura bloqueada`) : null,
    !sch.alembic && sch.schema_locked ? el("span", { class: "badge" }, "estructura bloqueada") : null,
    !sch.mount_rw ? el("span", { class: "badge warn" }, "montado :ro en el contenedor") : null,
    el("span", {}, `copias: ${sch.backups.length}`, sch.backups[0] ? ` (última ${fmtDate(new Date(sch.backups[0].mtime * 1000))})` : ""));

  const tabs = el("div", { class: "tabs" },
    el("button", { class: S.view === "data" ? "on" : "", onclick: () => { S.view = "data"; renderMain(); }, disabled: !t }, "Datos"),
    el("button", { class: S.view === "schema" ? "on" : "", onclick: () => { S.view = "schema"; renderMain(); }, disabled: !t }, "Estructura"),
    S.session.sql_console ? el("button", { class: S.view === "sql" ? "on" : "", onclick: () => { S.view = "sql"; renderMain(); } }, "SQL") : null);

  const backupBtn = el("button", { onclick: doBackup, disabled: S.session.read_only, title: "Copia con la API de backup de SQLite" }, "💾 Copia de seguridad");

  if (S.view === "sql") { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, S.db.name), tabs, el("div", { class: "spacer" }), backupBtn), info, renderConsole()); return; }
  if (!t) { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, S.db.name), tabs, el("div", { class: "spacer" }), backupBtn), info, el("div", { class: "empty" }, "La base de datos no tiene tablas.")); return; }
  if (S.view === "schema") { main.replaceChildren(el("div", { class: "toolbar" }, el("h2", {}, t.name), tabs, el("div", { class: "spacer" }), backupBtn), info, renderSchema(t)); return; }

  // --- vista de datos
  const search = el("input", { type: "search", placeholder: "Filtrar…", value: S.q });
  let deb;
  search.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => { S.q = search.value; S.page = 1; loadRows(); }, 350); });
  const colSel = el("select", { onchange: (e) => { S.col = e.target.value; S.page = 1; if (S.q) loadRows(); } },
    el("option", { value: "" }, "todas las columnas"),
    t.columns.map((c) => el("option", { value: c.name, selected: c.name === S.col }, c.name)));
  const toolbar = el("div", { class: "toolbar" },
    el("h2", {}, t.name), tabs, search, colSel, el("div", { class: "spacer" }),
    !t.editable ? el("span", { class: "badge", title: t.readonly_reason }, "solo lectura") : null,
    el("button", { class: "primary", disabled: !t.editable, onclick: () => openEditor(t, null) }, "+ Insertar"),
    backupBtn);

  const d = S.data;
  if (!d || d.table.name !== t.name) { main.replaceChildren(toolbar, info, el("div", { class: "empty" }, d ? "Cargando…" : "No se pudieron leer los datos.")); return; }
  const cols = d.table.columns;
  const thead = el("tr", {}, cols.map((c) => el("th", {
    onclick: () => { if (S.sort === c.name) S.desc = !S.desc; else { S.sort = c.name; S.desc = false; } loadRows(); },
  }, c.name, c.pk ? el("span", { class: "pk", title: "Clave primaria" }, "🔑") : null,
    el("span", { class: "t" }, c.type || ""), S.sort === c.name ? (S.desc ? " ▼" : " ▲") : "")));
  const tbody = el("tbody", {}, d.rows.map((r) => el("tr", { onclick: () => openEditor(d.table, r) },
    r.values.map((v, i) => { const f = formatCell(v, cols[i]); return el("td", { class: f.cls || "", title: f.title || null }, f.text); }))));
  const grid = el("div", { class: "grid-wrap" }, d.rows.length
    ? el("table", { class: "grid" }, el("thead", {}, thead), tbody)
    : el("div", { class: "empty pad" }, S.q ? "Ninguna fila coincide con el filtro." : "Tabla vacía."));

  const pages = d.total === null ? null : Math.max(1, Math.ceil(d.total / d.size));
  const sizeSel = el("select", { onchange: (e) => { S.size = +e.target.value; S.page = 1; loadRows(); } },
    [25, 50, 100, 250, 500].map((n) => el("option", { value: n, selected: n === S.size }, `${n} / página`)));
  const pager = el("div", { class: "pager" },
    el("button", { disabled: S.page <= 1, onclick: () => { S.page = 1; loadRows(); } }, "«"),
    el("button", { disabled: S.page <= 1, onclick: () => { S.page--; loadRows(); } }, "‹"),
    el("span", {}, `Página ${S.page}${pages ? ` de ${pages}` : ""}`),
    el("button", { disabled: pages ? S.page >= pages : d.rows.length < d.size, onclick: () => { S.page++; loadRows(); } }, "›"),
    pages ? el("button", { disabled: S.page >= pages, onclick: () => { S.page = pages; loadRows(); } }, "»") : null,
    el("span", { class: "muted" }, d.total === null ? "(demasiadas filas para contarlas)" : `${d.total} filas`),
    el("div", { class: "spacer" }), sizeSel,
    el("button", { onclick: loadRows, title: "Recargar" }, "⟳"));
  main.replaceChildren(toolbar, info, grid, pager);
}

function renderSchema(t) {
  const cols = el("table", { class: "grid" },
    el("thead", {}, el("tr", {}, ["#", "Columna", "Tipo", "Afinidad", "NOT NULL", "Defecto", "PK"].map((h) => el("th", {}, h)))),
    el("tbody", {}, t.columns.map((c, i) => el("tr", {}, el("td", {}, i), el("td", {}, c.name), el("td", {}, c.type),
      el("td", {}, c.affinity), el("td", {}, c.notnull ? "sí" : ""), el("td", {}, c.default ?? ""), el("td", {}, c.pk || "")))));
  return el("div", { class: "schema" },
    el("div", {}, el("h3", {}, "Identificación de filas"),
      t.key ? el("div", {}, t.key.kind === "pk" ? `Clave primaria: ${t.key.columns.join(", ")}` : "Sin clave primaria: se usa rowid")
        : el("div", { class: "muted" }, "No disponible"),
      !t.editable ? el("div", { class: "muted" }, `Solo lectura: ${t.readonly_reason}`) : null),
    el("div", {}, el("h3", {}, "Columnas"), cols),
    t.indexes && t.indexes.length ? el("div", {}, el("h3", {}, "Índices"), el("ul", {}, t.indexes.map((i) =>
      el("li", {}, el("code", {}, i.name), ` (${i.columns.join(", ")})`, i.unique ? " UNIQUE" : "", i.partial ? " parcial" : "", ` · ${i.origin}`)))) : null,
    t.foreign_keys && t.foreign_keys.length ? el("div", {}, el("h3", {}, "Claves foráneas"), el("ul", {}, t.foreign_keys.map((f) =>
      el("li", {}, el("code", {}, f.from), " → ", el("code", {}, `${f.table}(${f.to ?? "PK"})`), ` ON DELETE ${f.on_delete} ON UPDATE ${f.on_update}`)))) : null,
    el("div", {}, el("h3", {}, "SQL"), el("pre", { class: "sql" }, t.sql || "")));
}

// ------------------------------------------------------------------ copias de seguridad
async function doBackup() {
  try {
    const r = await api("POST", `/api/db/${S.dbId}/backup`);
    S.backupAsked.add(S.dbId);
    toast(`Copia creada: ${r.file} (${fmtSize(r.size)})`, "good");
    S.schema = { ...S.schema, ...(await api("GET", `/api/db/${S.dbId}`)) };
    renderMain();
    return true;
  } catch (err) { toast("No se pudo crear la copia: " + err.message, "bad"); return false; }
}

async function ensureBackup() {
  if (S.backupAsked.has(S.dbId)) return true;
  const choice = await choose("¿Copia de seguridad antes de escribir?",
    el("div", {}, el("p", {}, "Vas a modificar ", el("code", {}, S.db.path), "."),
      el("p", { class: "muted" }, "Se recomienda crear una copia con la API de backup de SQLite. Solo se pregunta una vez por base de datos en esta sesión.")),
    [{ label: "Cancelar", value: null }, { label: "Continuar sin copia", value: "skip" },
     { label: "Crear copia y continuar", value: "backup", cls: "primary" }]);
  if (!choice) return false;
  if (choice === "skip") { S.backupAsked.add(S.dbId); return true; }
  return doBackup();
}

// ------------------------------------------------------------------ editor de filas
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
  if (iso) return `→ ${fmtDate(iso.d)}${iso.hasTz ? "" : " (hora sin zona, interpretada como local)"}`;
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
    input.value = blob ? `BLOB de ${fmtSize(orig.size)} (no editable)` : text;
    input.disabled = !editable || blob;
    const hint = el("div", { class: "hint" });
    const nullCb = el("input", { type: "checkbox" });
    nullCb.checked = isNew ? true : orig === null;
    nullCb.disabled = !editable || blob;
    const nullLabel = el("label", { class: "nullbox" }, nullCb, isNew ? "por defecto" : "NULL");
    const update = () => {
      input.disabled = !editable || blob || nullCb.checked;
      if (nullCb.checked) { hint.textContent = isNew ? (c.default !== null ? `Defecto: ${c.default}` : c.pk ? "Automático / NULL" : "NULL") : ""; hint.className = "hint"; return; }
      const v = input.value;
      const j = parseJson(v);
      if (j !== undefined) { hint.textContent = "JSON válido"; hint.className = "hint"; }
      else if (json && v.trim()) { hint.textContent = "JSON no válido"; hint.className = "hint bad"; }
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
    }, title: "Ojo: números enteros muy grandes dentro del JSON pueden perder precisión" }, "Formatear/compactar JSON"));
    if (editable && isDate && !blob) tools.push(el("button", { type: "button", onclick: () => { nullCb.checked = false; input.value = nowLike(input.value, c); update(); } }, "Ahora"));
    const field = el("div", { class: "field" },
      el("label", {}, c.name, el("span", { class: "muted" }, `${c.type || "sin tipo"}${c.pk ? " · PK" : ""}${c.notnull ? " · NOT NULL" : ""}`)),
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
      if (isNull === f.initial.isNull && (isNull || f.input.value === f.initial.text)) continue; // sin cambios
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
      closeModal(); toast(isNew ? "Fila insertada" : "Fila guardada", "good"); loadRows();
    } catch (err) { toast(err.message, "bad"); }
  };

  const del = async () => {
    const ok = await choose("Borrar fila", "¿Seguro que quieres borrar esta fila? No se puede deshacer (salvo desde una copia).",
      [{ label: "Cancelar", value: false }, { label: "Borrar", value: true, cls: "danger solid" }]);
    if (!ok) { openEditor(table, row); return; }
    if (!(await ensureBackup())) return;
    try {
      await api("POST", `/api/db/${S.dbId}/delete`, { table: table.name, key: row.key });
      toast("Fila borrada", "good"); loadRows();
    } catch (err) { toast(err.message, "bad"); }
  };

  const keyDesc = row && table.key ? table.key.columns.map((k, i) => `${k}=${toEditText(row.key[i])}`).join(", ") : "";
  const buttons = editable
    ? [!isNew ? el("button", { class: "danger", onclick: del }, "Borrar") : null, el("div", { class: "spacer" }),
       el("button", { onclick: closeModal }, "Cancelar"), el("button", { class: "primary", onclick: save }, isNew ? "Insertar" : "Guardar")]
    : [el("span", { class: "muted" }, table.readonly_reason || "Solo lectura"), el("div", { class: "spacer" }), el("button", { onclick: closeModal }, "Cerrar")];
  openModal(isNew ? `Insertar en ${table.name}` : `${table.name} · ${keyDesc}`, fields.map((f) => f.field), buttons);
}

// ------------------------------------------------------------------ consola SQL
function renderConsole() {
  const ta = el("textarea", { placeholder: "SELECT * FROM … LIMIT 100", spellcheck: "false" });
  ta.value = S.lastSql || "";
  const out = el("div", { class: "result" }, el("div", { class: "muted pad" },
    "Una sentencia por ejecución. Las que escriben piden confirmación; la estructura está bloqueada salvo ALLOW_SCHEMA_CHANGES (y siempre en bases de datos con Alembic)."));
  const run = async (confirm = false) => {
    S.lastSql = ta.value;
    try {
      const r = await api("POST", `/api/db/${S.dbId}/sql`, { sql: ta.value, confirm });
      if (r.needs_confirm) {
        const ok = await choose("Sentencia de escritura", el("div", {},
          el("p", {}, r.ddl ? "Esta sentencia CAMBIA LA ESTRUCTURA de la base de datos." : "Esta sentencia modifica datos."),
          el("pre", { class: "sql" }, ta.value)),
          [{ label: "Cancelar", value: false }, { label: "Ejecutar", value: true, cls: "danger solid" }]);
        if (ok && (await ensureBackup())) return run(true);
        return;
      }
      if (!r.columns.length) { out.replaceChildren(el("div", { class: "pad" }, r.wrote ? `Hecho. Filas afectadas: ${r.changes}` : "Sin resultados.")); }
      else {
        const cols = r.columns.map((n) => ({ name: n, type: "" }));
        out.replaceChildren(el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, r.columns.map((n) => el("th", {}, n)))),
          el("tbody", {}, r.rows.map((row) => el("tr", {}, row.map((v, i) => { const f = formatCell(v, cols[i]); return el("td", { class: f.cls || "", title: f.title || null }, f.text); }))))),
          r.truncated ? el("div", { class: "muted pad" }, "Resultado truncado.") : null);
      }
      if (r.wrote) toast(`Escritura completada (${r.changes} filas)`, "good");
    } catch (err) { out.replaceChildren(el("div", { class: "pad error" }, err.message)); }
  };
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
  return el("div", { class: "console" }, ta,
    el("div", { class: "row", style: "display:flex;gap:8px" }, el("button", { class: "primary", onclick: () => run() }, "Ejecutar (Ctrl+Enter)")), out);
}

start().catch(() => showLogin());
