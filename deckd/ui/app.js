// Desk Studio — vanilla JS, no build step. Talks to deskd's /api with the
// token deskd injected into this page.
const TOKEN = document.querySelector('meta[name="desk-token"]').content;
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch(`/api${path}`, { ...opts, headers: { "x-desk-token": TOKEN, "content-type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok && r.headers.get("content-type")?.includes("json")) throw new Error((await r.json()).error || r.statusText);
  if (!r.ok) throw new Error(r.statusText);
  return r;
};
const TILE_HEX = { blue: "#a8c7fa", violet: "#d0bcff", emerald: "#9ee6c3", amber: "#ffd27a", rose: "#ffb4a8", latte: "#f2c9a0", zinc: "#8a8a8a" };
const VALUE = {
  shell: ["command (runs in /bin/sh)", "cmd", "say hello"],
  app: ["application name", "name", "Safari"],
  url: ["URL", "url", "https://g8row.xyz"],
  applescript: ["AppleScript source", "script", 'display notification "hi"'],
  shortcut: ["Shortcut name", "name", "Desk lights"],
};

let meta, cfg, saved, sel = -1;

const dirty = () => JSON.stringify(cfg) !== saved;
function touch() {
  $("save").disabled = !dirty();
  $("saved").textContent = dirty() ? "unsaved changes" : "";
  render();
}

// ---- panes -----------------------------------------------------------------
function renderPanes() {
  const all = [...cfg.panes, ...Object.keys(meta.panes).filter((p) => !cfg.panes.includes(p))];
  $("strip").style.gridTemplateColumns = `repeat(${cfg.panes.length},minmax(0,1fr))`;
  $("strip").innerHTML = cfg.panes.map((p) => `<span>${p}</span>`).join("");
  const ol = $("panelist");
  ol.innerHTML = "";
  all.forEach((p) => {
    const on = cfg.panes.includes(p);
    const li = document.createElement("li");
    li.className = on ? "" : "off";
    li.draggable = on;
    li.dataset.pane = p;
    li.innerHTML = `<span class="grip">⋮⋮</span><input type="checkbox" ${on ? "checked" : ""}>
      <span class="name">${p}</span><span class="desc">${meta.panes[p]}</span>
      <button class="btn sm ghost" data-a="up">↑</button><button class="btn sm ghost" data-a="down">↓</button>
      <button class="btn sm" data-a="show" ${on ? "" : "disabled"}>show</button>`;
    li.querySelector("input").onchange = (e) => {
      if (e.target.checked) cfg.panes.push(p);
      else if (cfg.panes.length > 1) cfg.panes = cfg.panes.filter((x) => x !== p);
      touch();
    };
    li.querySelectorAll("button").forEach((b) => (b.onclick = () => paneBtn(p, b.dataset.a)));
    li.ondragstart = (e) => { e.dataTransfer.setData("text/plain", p); li.classList.add("drag"); };
    li.ondragend = () => li.classList.remove("drag");
    li.ondragover = (e) => { if (on) e.preventDefault(); };
    li.ondrop = (e) => {
      e.preventDefault();
      const from = cfg.panes.indexOf(e.dataTransfer.getData("text/plain"));
      const to = cfg.panes.indexOf(p);
      if (from < 0 || to < 0) return;
      const [x] = cfg.panes.splice(from, 1);
      cfg.panes.splice(to, 0, x);
      touch();
    };
    ol.appendChild(li);
  });
}
function paneBtn(p, a) {
  const i = cfg.panes.indexOf(p);
  if (a === "show") return api("/nav", { method: "POST", body: JSON.stringify({ pane: p }) });
  if (i < 0) return;
  const j = a === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= cfg.panes.length) return;
  [cfg.panes[i], cfg.panes[j]] = [cfg.panes[j], cfg.panes[i]];
  touch();
}

// ---- deck ------------------------------------------------------------------
const describe = (a) =>
  a.type === "builtin" ? meta.builtins[a.id] || a.id : a.type === "shell" ? `$ ${a.cmd}` : a.type === "url" ? a.url : a.type === "app" ? `open ${a.name}` : a.type === "shortcut" ? `shortcut ${a.name}` : "applescript";
// Same packing as the tablet (pocketjs/apps/desk/deck.tsx): consecutive tiles
// with one group are one item; first free cell where the span fits, else 1×1.
function pack(tiles) {
  const items = [];
  tiles.forEach((t, i) => {
    const last = items[items.length - 1];
    if (t.group && last && tiles[last.idx[0]].group === t.group) last.idx.push(i);
    else items.push({ idx: [i], w: Math.min(4, t.w || 1), h: Math.min(3, t.h || 1) });
  });
  const used = [0, 1, 2].map(() => [false, false, false, false]);
  const fits = (c, r, w, h) => {
    if (c + w > 4 || r + h > 3) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (used[y][x]) return false;
    return true;
  };
  for (const it of items) {
    for (const [w, h] of [[it.w, it.h], [1, 1]]) {
      const i = [...Array(12).keys()].find((k) => fits(k % 4, Math.floor(k / 4), w, h));
      if (i === undefined) continue;
      Object.assign(it, { col: i % 4, row: Math.floor(i / 4), w, h });
      for (let y = it.row; y < it.row + h; y++) for (let x = it.col; x < it.col + w; x++) used[y][x] = true;
      break;
    }
  }
  return items;
}
// Pixel boxes on the tablet's 512×271 deck page — same maths as deck.tsx.
const PW = 512, PH = 271;
function boxes(items, pad = 10, gap = 8, railW = 66) {
  const placed = items.filter((it) => it.col !== undefined);
  const rails = [0, 1, 2, 3].map((c) => {
    const inCol = placed.filter((it) => it.col <= c && c < it.col + it.w);
    return inCol.length === 1 && inCol[0].w === 1 && inCol[0].h === 3 && inCol[0].idx.length > 1;
  });
  const free = PW - 2 * pad - gap * 3 - rails.filter(Boolean).length * railW;
  const cw = rails.map((r) => (r ? railW : free / rails.filter((x) => !x).length));
  const cx = cw.map((_, c) => pad + cw.slice(0, c).reduce((a, b) => a + b, 0) + gap * c);
  const rh = (PH - 2 * pad - gap * 2) / 3;
  const ry = (r) => pad + r * (rh + gap);
  for (const it of placed) {
    const x = cx[it.col], y = ry(it.row);
    it.box = { x, y, w: cx[it.col + it.w - 1] + cw[it.col + it.w - 1] - x, h: ry(it.row + it.h - 1) + rh - y };
  }
}
// Live fields (on/sub/level) and the focus clock, from deskd's tablet state.
let live = {};
async function pullLive() {
  try {
    const st = await (await api("/state")).json();
    live = Object.fromEntries((st.deck?.tiles || []).map((t) => [t.id, t]));
    live.__focus = st.focus;
  } catch {}
}
const icon = (name, ink, big) => {
  const i = document.createElement("img");
  i.className = `ico${big ? " big" : ""}`;
  i.alt = "";
  i.src = `/icons/${name || "dot"}-${big ? 48 : 32}${ink ? "d" : "l"}.svg`;
  i.onerror = () => { i.onerror = null; i.src = `/icons/${name || "dot"}-32${ink ? "d" : "l"}.svg`; };
  return i;
};
const text = (main, sub) => {
  const d = document.createElement("span");
  d.className = "txt";
  d.innerHTML = `<span class="t1"></span><span class="t2"></span>`;
  d.children[0].textContent = main;
  d.children[1].textContent = sub;
  return d;
};
function renderTiles() {
  const g = $("tiles");
  g.innerHTML = "";
  const items = pack(cfg.tiles);
  boxes(items);
  const pct = (v, of) => `${(v / of) * 100}%`;
  for (const it of items.filter((x) => x.box)) {
    const wrap = document.createElement("div");
    wrap.className = "it";
    const b = it.box;
    Object.assign(wrap.style, { left: pct(b.x, PW), top: pct(b.y, PH), width: pct(b.w, PW), height: pct(b.h, PH) });
    const vertical = b.h > b.w;
    if (vertical) wrap.style.flexDirection = "column";
    const n = it.idx.length;
    it.idx.forEach((i, k) => {
      const t = { ...cfg.tiles[i], ...pick(live[cfg.tiles[i].id]) };
      const on = !!(t.on || t.fill);
      const color = TILE_HEX[t.color] || TILE_HEX.zinc;
      const el = document.createElement("button");
      el.type = "button";
      el.title = `${t.label} — ${describe(cfg.tiles[i].action)}`;
      el.setAttribute("aria-label", `edit ${t.label}`);
      if (i === sel) el.classList.add("sel");
      el.onclick = () => { sel = i; openEditor(); render(); $("editor").scrollIntoView({ block: "nearest", behavior: "smooth" }); };
      const ic = t.on && t.iconOn ? t.iconOn : t.icon;
      if (n > 1) {
        // split pill: round outer ends, tight inner corners
        el.classList.add("seg");
        const R = "999px", r = "8px";
        el.style.borderRadius = k === 0 ? (vertical ? `${R} ${R} ${r} ${r}` : `${R} ${r} ${r} ${R}`) : k === n - 1 ? (vertical ? `${r} ${r} ${R} ${R}` : `${r} ${R} ${R} ${r}`) : r;
        if (on) { el.style.background = color; el.classList.add("fill"); }
        el.append(t.icon ? icon(ic, on) : text(t.label.toLowerCase(), ""));
        wrap.appendChild(el);
        const lvl = it.idx.map((j) => live[cfg.tiles[j].id]?.level).find((v) => typeof v === "number");
        if (k === 0 && vertical && n === 2 && lvl !== undefined) {
          const l = document.createElement("span");
          l.className = "lvl";
          l.textContent = lvl;
          wrap.appendChild(l);
        }
        return;
      }
      if (t.shape === "circle") {
        el.classList.add("circ");
        const d = Math.min(b.w, b.h) - 6; // as the tablet: never wider than its cell
        el.style.width = el.style.height = `calc(var(--px) * ${d})`;
        if (on) { el.style.background = color; el.classList.add("fill"); }
        el.append(icon(ic, on, true));
        const s = document.createElement("span");
        s.className = "t2";
        s.style.color = on ? "#101010" : color;
        s.textContent = on ? (t.sub || t.label).toUpperCase() : `● ${(t.sub || t.label).toLowerCase()}`;
        el.append(s);
      } else if (it.w > 1 || t.sub || LIVE_TEXT.test(cfg.tiles[i].action.id || "")) {
        el.classList.add("pill");
        if (it.w > 1) el.classList.add("wide");
        const focusing = t.live === "focus" || /^focus\./.test(cfg.tiles[i].action.id || "");
        const f = live.__focus || {};
        const lit = on || (focusing && f.mode === "running");
        if (lit) { el.style.background = color; el.classList.add("fill"); }
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.style.height = `calc(var(--px) * ${Math.min(b.h - 12, it.w > 1 ? 64 : 50)})`;
        chip.style.background = lit ? "#101010" : color;
        chip.append(icon(ic, !lit));
        const [main, sub] = focusing
          ? [f.left || "25:00", f.mode === "running" ? "focus" : t.label.toLowerCase()]
          : it.w === 1 && t.sub ? [t.sub.toLowerCase(), t.label.toLowerCase()] : [t.label.toLowerCase(), (t.sub || "").toLowerCase()];
        el.append(chip, text(main, sub));
      } else {
        el.classList.add("itile");
        if (on) { el.style.background = color; el.classList.add("fill"); }
        el.append(t.icon ? icon(ic, on) : text(t.label.toLowerCase(), ""));
        if (!on) {
          const m = document.createElement("span");
          m.className = "mark";
          m.style.background = color;
          el.append(m);
        }
      }
      wrap.appendChild(el);
    });
    g.appendChild(wrap);
  }
  const dropped = items.filter((it) => !it.box).flatMap((it) => it.idx.map((i) => cfg.tiles[i].label));
  $("dropped").textContent = dropped.length ? `no room on the tablet for: ${dropped.join(", ")} — shrink or remove a tile` : `${cfg.tiles.length} / 12 tiles`;
  $("addtile").disabled = cfg.tiles.length >= 12;
}
const pick = (l) => {
  const o = {};
  if (!l) return o;
  for (const k of ["on", "sub", "live"]) if (l[k] !== undefined && l[k] !== null) o[k] = l[k];
  return o;
};
$("addtile").onclick = () => {
  cfg.tiles.push({ id: `tile-${Date.now() % 100000}`, label: "New", color: "blue", icon: "bolt", action: { type: "shell", cmd: "" } });
  sel = cfg.tiles.length - 1;
  openEditor();
  touch();
};
// builtins whose tile always has live text on the tablet (→ drawn as a pill)
const LIVE_TEXT = /^(focus\.|caffeine\.)/;
function openEditor() {
  const t = cfg.tiles[sel];
  $("editor").hidden = !t;
  if (!t) return;
  $("edtitle").textContent = t.label.toLowerCase();
  $("f-label").value = t.label;
  $("f-sub").value = t.sub || "";
  $("f-type").value = t.action.type;
  $("f-colors").innerHTML = "";
  meta.colors.forEach((c) => {
    const s = document.createElement("span");
    s.className = `sw${c === t.color ? " on" : ""}`;
    s.style.background = TILE_HEX[c];
    s.title = c;
    s.onclick = () => { t.color = c; openEditor(); touch(); };
    $("f-colors").appendChild(s);
  });
  const opts = (v) => `<option value="">none</option>` + meta.icons.map((n) => `<option ${n === v ? "selected" : ""}>${n}</option>`).join("");
  $("f-icon").innerHTML = opts(t.icon);
  $("f-iconon").innerHTML = opts(t.iconOn);
  $("f-size").value = `${t.w || 1}x${t.h || 1}`;
  $("f-group").value = t.group || "";
  $("f-fill").checked = !!t.fill;
  $("f-circle").checked = t.shape === "circle";
  // AppleScript / Shortcuts only run on macOS: offer them there (or when a tile already uses one)
  for (const o of $("f-type").options) o.hidden = meta.platform !== "darwin" && (o.value === "applescript" || o.value === "shortcut") && o.value !== t.action.type;
  $("f-builtin").innerHTML = Object.entries(meta.builtins).map(([k, v]) => `<option value="${k}">${k} — ${v}</option>`).join("");
  syncActionFields();
  $("edresult").textContent = "";
}
function syncActionFields() {
  const t = cfg.tiles[sel];
  const a = t.action;
  $("w-builtin").hidden = a.type !== "builtin";
  $("w-value").hidden = a.type === "builtin";
  if (a.type === "builtin") $("f-builtin").value = a.id;
  else {
    const [label, key, ph] = VALUE[a.type];
    $("f-valuelabel").textContent = label;
    $("f-value").placeholder = ph;
    $("f-value").value = a[key] || "";
  }
}
$("f-label").oninput = (e) => { cfg.tiles[sel].label = e.target.value; touch(); };
$("f-sub").oninput = (e) => { const t = cfg.tiles[sel]; if (e.target.value) t.sub = e.target.value; else delete t.sub; touch(); };
$("f-type").onchange = (e) => {
  const type = e.target.value;
  cfg.tiles[sel].action = type === "builtin" ? { type, id: Object.keys(meta.builtins)[0] } : { type, [VALUE[type][1]]: "" };
  syncActionFields();
  touch();
};
const setOpt = (k, v) => { const t = cfg.tiles[sel]; if (v) t[k] = v; else delete t[k]; touch(); };
$("f-icon").onchange = (e) => setOpt("icon", e.target.value);
$("f-iconon").onchange = (e) => setOpt("iconOn", e.target.value);
$("f-group").oninput = (e) => setOpt("group", e.target.value.trim());
$("f-fill").onchange = (e) => setOpt("fill", e.target.checked);
$("f-circle").onchange = (e) => setOpt("shape", e.target.checked ? "circle" : "");
$("f-size").onchange = (e) => {
  const [w, h] = e.target.value.split("x").map(Number);
  const t = cfg.tiles[sel];
  if (w > 1) t.w = w; else delete t.w;
  if (h > 1) t.h = h; else delete t.h;
  touch();
};
$("f-builtin").onchange = (e) => { cfg.tiles[sel].action.id = e.target.value; touch(); };
$("f-value").oninput = (e) => { const a = cfg.tiles[sel].action; a[VALUE[a.type][1]] = e.target.value; touch(); };
$("edclose").onclick = () => { sel = -1; $("editor").hidden = true; render(); };
$("eddel").onclick = () => { cfg.tiles.splice(sel, 1); sel = -1; $("editor").hidden = true; touch(); };
const move = (d) => {
  const j = sel + d;
  if (j < 0 || j >= cfg.tiles.length) return;
  [cfg.tiles[sel], cfg.tiles[j]] = [cfg.tiles[j], cfg.tiles[sel]];
  sel = j;
  touch();
};
$("edleft").onclick = () => move(-1);
$("edright").onclick = () => move(1);
$("edtest").onclick = async () => {
  $("edresult").textContent = "running…";
  try {
    const r = await (await api("/tile/test", { method: "POST", body: JSON.stringify(cfg.tiles[sel]) })).json();
    $("edresult").textContent = r.ok ? "ran ✓" : `failed: ${r.error}`;
  } catch (e) {
    $("edresult").textContent = `failed: ${e.message}`;
  }
};

// ---- look + claude -----------------------------------------------------------
function renderLook() {
  document.documentElement.style.setProperty("--accent", cfg.accent);
  $("accents").innerHTML = "";
  Object.entries(meta.accents).forEach(([name, hex]) => {
    const s = document.createElement("span");
    s.className = `sw${hex === cfg.accent ? " on" : ""}`;
    s.style.background = hex;
    s.title = name;
    s.onclick = () => { cfg.accent = hex; touch(); };
    $("accents").appendChild(s);
  });
  if (document.activeElement !== $("accent")) $("accent").value = cfg.accent;
  $("c-flash").checked = cfg.claude.flash;
  $("c-sound").checked = cfg.claude.sound;
  $("c-approvals").checked = cfg.claude.approvals;
  if (document.activeElement !== $("c-timeout")) $("c-timeout").value = cfg.claude.approvalTimeoutSec;
  if (document.activeElement !== $("c-editor")) $("c-editor").value = cfg.claude.editor;
  if (document.activeElement !== $("f-minutes")) $("f-minutes").value = cfg.focus.minutes;
}
$("accent").oninput = (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) { cfg.accent = e.target.value.toLowerCase(); touch(); } };
["flash", "sound", "approvals"].forEach((k) => ($(`c-${k}`).onchange = (e) => { cfg.claude[k] = e.target.checked; touch(); }));
$("c-timeout").oninput = (e) => { cfg.claude.approvalTimeoutSec = Number(e.target.value) || 10; touch(); };
$("c-editor").oninput = (e) => { cfg.claude.editor = e.target.value; touch(); };
$("f-minutes").oninput = (e) => { cfg.focus.minutes = Number(e.target.value) || 25; touch(); };

// ---- save, status, preview -----------------------------------------------------
$("save").onclick = async () => {
  try {
    const r = await (await api("/config", { method: "PUT", body: JSON.stringify(cfg) })).json();
    cfg = r.config;
    saved = JSON.stringify(cfg);
    sel = Math.min(sel, cfg.tiles.length - 1);
    touch();
    $("saved").textContent = "pushed to the tablet ✓";
    setTimeout(shot, 900);
  } catch (e) {
    $("saved").textContent = `save failed: ${e.message}`;
  }
};
let shotUrl;
async function shot() {
  try {
    const b = await (await api("/screenshot")).blob();
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(b);
    $("screen").src = shotUrl;
  } catch {
    $("noshot").textContent = "tablet not reachable over adb or ssh";
  }
}
$("shot").onclick = shot;
setInterval(() => { if ($("live").checked && !document.hidden) shot(); }, 3000);
async function status() {
  try {
    const m = await (await api("/meta")).json();
    $("tabdot").className = m.tablet ? "dot on" : "dot";
    $("tabstate").textContent = m.tablet ? `tablet connected${m.via ? ` (${m.via})` : ""}` : "tablet offline";
    $("tabstate").title = m.host || "";
  } catch {
    $("tabstate").textContent = "deskd unreachable";
  }
}
setInterval(async () => {
  status();
  const before = JSON.stringify(live);
  await pullLive();
  if (JSON.stringify(live) !== before && !document.hidden) renderTiles(); // only when state moved
}, 4000);

function render() {
  renderPanes();
  renderTiles();
  renderLook();
}

(async () => {
  meta = await (await api("/meta")).json();
  if (meta.platform !== "darwin") {
    VALUE.shell[2] = "notify-send hello";
    VALUE.app = ["application (name, .desktop id or command)", "name", "Firefox"];
  }
  const r = await (await api("/config")).json();
  cfg = r.config;
  saved = JSON.stringify(cfg);
  $("cfgpath").textContent = r.path.split("/").slice(-2).join("/");
  status();
  await pullLive();
  render();
  shot();
})();
