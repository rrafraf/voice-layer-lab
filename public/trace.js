const LEVELS = ["trace", "debug", "info", "warn", "error"];
const WEIGHT = { trace: 10, debug: 20, info: 30, ok: 30, warn: 40, error: 50 };
const TAG = { trace: "TRC", debug: "DBG", info: "INF", ok: "OK ", warn: "WRN", error: "ERR" };
const MAX_ROWS = 1500;
const STORAGE_LEVEL = "voice.trace.level";
const STORAGE_COLLAPSED = "voice.trace.collapsed";

const records = [];
let seq = 0;
let serverSeq = 0;
let minWeight = WEIGHT.trace;
let srcFilter = "";
let follow = true;
let heldCount = 0;
let selectedSeq = 0;
let pollFailNoted = false;
let flushTimer;
let ignoreScroll = false;
const pendingPost = [];

function nowIso() {
  return new Date().toISOString();
}

function normalizeLevel(value, fallback = "info") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "ok") return "ok";
  return LEVELS.includes(raw) ? raw : fallback;
}

export function matchesTraceSrc(src, filter) {
  if (!filter) return true;
  return src === filter || src.startsWith(`${filter}.`);
}

function formatLine(record) {
  const time = record.at.slice(11, 23).padEnd(12, "0");
  const src = record.src.length >= 14 ? record.src : record.src.padEnd(14);
  const data = record.data ? `  ${record.data}` : "";
  return `${time}  ${TAG[record.lvl] || record.lvl}  ${src}  ${record.msg}${data}`;
}

function $(id) {
  return document.getElementById(id);
}

function ensurePanel() {
  let dock = $("trace-dock");
  if (dock) return dock;
  dock = document.createElement("aside");
  dock.id = "trace-dock";
  dock.className = "trace-dock";
  dock.innerHTML = `
    <button type="button" id="trace-resize" class="trace-resize" aria-label="Resize Trace"></button>
    <div class="trace-dock-bar">
      <button type="button" id="trace-toggle" aria-expanded="true">▾ Trace</button>
      <span id="trace-last" class="trace-last"></span>
      <label class="trace-level-label">lvl
        <select id="trace-level">
          <option value="trace">TRACE</option>
          <option value="debug">DEBUG</option>
          <option value="info">INFO</option>
          <option value="warn">WARN</option>
          <option value="error">ERROR</option>
        </select>
      </label>
      <button type="button" id="trace-follow" aria-pressed="true">Follow</button>
      <button type="button" id="trace-filter-clear" hidden>Clear filter</button>
      <button type="button" id="trace-copy">Copy</button>
      <button type="button" id="trace-clear">Clear</button>
    </div>
    <ol id="trace-log" class="trace-log" aria-live="polite"></ol>
  `;
  document.body.append(dock);
  return dock;
}

function visible(record) {
  if (srcFilter) return matchesTraceSrc(record.src, srcFilter);
  return (WEIGHT[record.lvl] ?? 30) >= minWeight;
}

function paintRow(record) {
  const row = document.createElement("li");
  row.className = `trace-row ${record.lvl}`;
  row.dataset.seq = String(record.seq);
  row.dataset.src = record.src;
  row.hidden = !visible(record);
  row.classList.toggle("selected", record.seq === selectedSeq);
  const time = document.createElement("span");
  time.className = "t";
  time.textContent = record.at.slice(11, 23);
  const tag = document.createElement("span");
  tag.className = "lvl";
  tag.textContent = TAG[record.lvl] || record.lvl;
  const src = document.createElement("span");
  src.className = "src";
  src.textContent = record.src;
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = record.data ? `${record.msg}  ${record.data}` : record.msg;
  row.append(time, tag, src, msg);
  return row;
}

function nearBottom(log) {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 32;
}

function updateFollowUi() {
  const button = $("trace-follow");
  if (button) {
    button.setAttribute("aria-pressed", follow ? "true" : "false");
    button.classList.toggle("active", follow);
    button.textContent = follow ? "Follow" : heldCount ? `Follow · ${heldCount}` : "Follow";
  }
  const chip = $("trace-filter-clear");
  if (chip) {
    chip.hidden = !srcFilter;
    chip.textContent = srcFilter ? `src ${srcFilter} ×` : "Clear filter";
  }
  $("trace-dock")?.classList.toggle("paused", !follow);
}

function maybeFollow() {
  if (!follow) return;
  const log = $("trace-log");
  if (!log) return;
  ignoreScroll = true;
  log.scrollTop = log.scrollHeight;
  requestAnimationFrame(() => {
    ignoreScroll = false;
  });
}

function noteHeld(record) {
  if (!visible(record)) return;
  if (follow) {
    maybeFollow();
    return;
  }
  heldCount += 1;
  updateFollowUi();
}

function applyFilter() {
  const log = $("trace-log");
  if (!log) return;
  for (const row of log.children) {
    const record = records.find((item) => String(item.seq) === row.dataset.seq);
    row.hidden = record ? !visible(record) : false;
    row.classList.toggle("selected", record?.seq === selectedSeq);
  }
  const last = [...records].reverse().find((item) => (WEIGHT[item.lvl] ?? 0) >= WEIGHT.warn);
  const lastEl = $("trace-last");
  if (lastEl) lastEl.textContent = last ? `${TAG[last.lvl]} ${last.msg}` : "";
  updateFollowUi();
  maybeFollow();
}

function setFollow(next) {
  follow = next;
  if (follow) heldCount = 0;
  updateFollowUi();
  maybeFollow();
}

function pinTraceSrc(src, options = {}) {
  srcFilter = String(src || "");
  selectedSeq = 0;
  if (options.follow === false) setFollow(false);
  else setFollow(true);
  applyFilter();
}

function mirrorConsole(record) {
  if ((WEIGHT[record.lvl] ?? 30) < minWeight) return;
  const line = formatLine(record);
  if (record.lvl === "error") console.error(line);
  else if (record.lvl === "warn") console.warn(line);
  else if (record.lvl === "trace") console.debug(line);
  else console.log(line);
}

function queuePost(record) {
  pendingPost.push({
    at: record.at,
    lvl: record.lvl === "ok" ? "info" : record.lvl,
    src: record.src,
    msg: record.msg,
    data: record.data,
  });
  if (pendingPost.length >= 20) {
    void flushPost();
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushPost(), 400);
}

async function flushPost() {
  if (!pendingPost.length) return;
  const batch = pendingPost.splice(0, pendingPost.length);
  try {
    await fetch("/api/trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
  } catch {
    pendingPost.unshift(...batch);
  }
}

function emit(level, src, msg, data, origin = "ui") {
  const record = {
    seq: ++seq,
    at: nowIso(),
    lvl: normalizeLevel(level),
    src: String(src || "ui").slice(0, 48),
    msg: String(msg || "").slice(0, 240),
    origin,
  };
  if (data != null && data !== "") record.data = String(data).slice(0, 800);
  records.push(record);
  if (records.length > MAX_ROWS) records.splice(0, records.length - MAX_ROWS);

  const log = $("trace-log");
  if (log) {
    log.append(paintRow(record));
    while (log.childElementCount > MAX_ROWS) log.firstElementChild.remove();
    noteHeld(record);
  }

  const lastEl = $("trace-last");
  if (lastEl && (WEIGHT[record.lvl] ?? 0) >= WEIGHT.warn) {
    lastEl.textContent = `${TAG[record.lvl]} ${record.msg}`;
  }

  mirrorConsole(record);
  if (origin === "ui") queuePost(record);
  return record;
}

function adoptServer(entry) {
  if (!entry || typeof entry.seq !== "number") return;
  if (entry.seq <= serverSeq) return;
  serverSeq = entry.seq;
  if (entry.origin === "ui") return;
  const record = {
    seq: ++seq,
    at: entry.at || nowIso(),
    lvl: normalizeLevel(entry.lvl || entry.level),
    src: entry.src || "srv",
    msg: entry.msg || "",
    origin: "srv",
  };
  if (entry.data) record.data = entry.data;
  records.push(record);
  if (records.length > MAX_ROWS) records.splice(0, records.length - MAX_ROWS);
  $("trace-log")?.append(paintRow(record));
  if ((WEIGHT[record.lvl] ?? 0) >= WEIGHT.warn) {
    const lastEl = $("trace-last");
    if (lastEl) lastEl.textContent = `${TAG[record.lvl]} ${record.msg}`;
  }
  noteHeld(record);
}

async function pullServer() {
  try {
    const response = await fetch(`/api/trace?after=${serverSeq}&origin=srv`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    pollFailNoted = false;
    for (const entry of payload.entries ?? []) adoptServer(entry);
    if (typeof payload.seq === "number" && payload.seq > serverSeq) serverSeq = payload.seq;
  } catch (error) {
    if (!pollFailNoted) {
      pollFailNoted = true;
      emit("warn", "trace.poll", "srv unreachable", error.message ?? String(error));
    }
  }
}

function setLevel(level) {
  const next = normalizeLevel(level, "trace");
  minWeight = WEIGHT[next === "ok" ? "info" : next] ?? WEIGHT.trace;
  const select = $("trace-level");
  if (select) select.value = next === "ok" ? "info" : next;
  try {
    localStorage.setItem(STORAGE_LEVEL, select?.value ?? "trace");
  } catch {}
  applyFilter();
  void fetch("/api/trace/level", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level: select?.value ?? "trace" }),
  }).catch(() => undefined);
}

function setCollapsed(collapsed) {
  const dock = $("trace-dock");
  const toggle = $("trace-toggle");
  if (!dock) return;
  dock.classList.toggle("collapsed", collapsed);
  if (collapsed) {
    dock.style.width = "";
    dock.style.height = "";
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.textContent = collapsed ? "Trace" : "▾ Trace";
  }
  try {
    localStorage.setItem(STORAGE_COLLAPSED, collapsed ? "1" : "0");
  } catch {}
}

function bindResize(dock) {
  const handle = $("trace-resize");
  if (!handle || handle.dataset.bound) return;
  handle.dataset.bound = "1";
  handle.addEventListener("mousedown", (event) => {
    if (dock.classList.contains("collapsed")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = dock.offsetWidth;
    const startH = dock.offsetHeight;
    const move = (moveEvent) => {
      const width = Math.min(window.innerWidth * 0.72, Math.max(280, startW + (startX - moveEvent.clientX)));
      const height = Math.min(window.innerHeight * 0.85, Math.max(180, startH + (moveEvent.clientY - startY)));
      dock.style.width = `${width}px`;
      dock.style.height = `${height}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function bindPanel() {
  const dock = ensurePanel();
  const log = $("trace-log");
  const savedLevel = (() => {
    try {
      return localStorage.getItem(STORAGE_LEVEL) || "trace";
    } catch {
      return "trace";
    }
  })();
  const savedCollapsed = (() => {
    try {
      return localStorage.getItem(STORAGE_COLLAPSED) === "1";
    } catch {
      return false;
    }
  })();

  $("trace-level")?.addEventListener("change", (event) => setLevel(event.target.value));
  $("trace-toggle")?.addEventListener("click", () => setCollapsed(!dock.classList.contains("collapsed")));
  $("trace-follow")?.addEventListener("click", () => setFollow(!follow));
  $("trace-filter-clear")?.addEventListener("click", () => pinTraceSrc("", { follow: false }));
  $("trace-copy")?.addEventListener("click", async () => {
    const text = records.filter(visible).map(formatLine).join("\n");
    await navigator.clipboard.writeText(text);
    const button = $("trace-copy");
    if (button) {
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1100);
    }
  });
  $("trace-clear")?.addEventListener("click", () => {
    records.length = 0;
    srcFilter = "";
    heldCount = 0;
    selectedSeq = 0;
    $("trace-log")?.replaceChildren();
    const lastEl = $("trace-last");
    if (lastEl) lastEl.textContent = "";
    setFollow(false);
    emit("info", "trace", "cleared", "panel only; file keeps history");
  });

  log?.addEventListener("scroll", () => {
    if (ignoreScroll) return;
    const atBottom = nearBottom(log);
    if (follow && !atBottom) {
      follow = false;
      updateFollowUi();
    } else if (!follow && atBottom) {
      heldCount = 0;
      follow = true;
      updateFollowUi();
    }
  });

  log?.addEventListener("click", (event) => {
    const row = event.target.closest(".trace-row");
    if (!row) return;
    const record = records.find((item) => String(item.seq) === row.dataset.seq);
    if (!record) return;
    selectedSeq = record.seq;
    srcFilter = record.src;
    setFollow(false);
    applyFilter();
  });

  document.addEventListener("click", (event) => {
    const host = event.target.closest("[data-trace-src]");
    if (!host || host.closest("#trace-dock")) return;
    pinTraceSrc(host.getAttribute("data-trace-src"), { follow: true });
  }, true);
  document.addEventListener("change", (event) => {
    const host = event.target.closest("[data-trace-src]");
    if (!host || host.closest("#trace-dock")) return;
    pinTraceSrc(host.getAttribute("data-trace-src"), { follow: true });
  }, true);

  setLevel(savedLevel);
  setCollapsed(savedCollapsed);
  bindResize(dock);
  updateFollowUi();
}

function hookGlobals() {
  window.addEventListener("error", (event) => {
    emit("error", "ui.err", event.message || "window.error", event.filename ? `${event.filename}:${event.lineno}` : undefined);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    emit("error", "ui.reject", reason?.message ?? String(reason));
  });

  const rawFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(url).includes("/api/trace")) return rawFetch(input, init);
    const method = init?.method || (typeof input !== "string" && input.method) || "GET";
    const started = performance.now();
    try {
      const response = await rawFetch(input, init);
      const path = String(url).replace(location.origin, "");
      emit(
        response.ok ? "debug" : "error",
        "http",
        `${method} ${path}`,
        `status=${response.status} ms=${Math.round(performance.now() - started)}`,
      );
      return response;
    } catch (error) {
      emit("error", "http", `${method} ${url}`, error.message ?? String(error));
      throw error;
    }
  };
}

function drainBootQueue() {
  for (const item of window.__traceBoot ?? []) {
    emit(item.level || "error", item.src || "boot", item.msg || "boot", item.data);
  }
  window.__traceBoot = [];
}

bindPanel();
hookGlobals();
drainBootQueue();
emit("info", "ui", "boot", `href=${location.pathname}${location.search}`);
void pullServer();
setInterval(() => void pullServer(), 800);
window.addEventListener("beforeunload", () => void flushPost());

export function logEvent(level, message, details) {
  return emit(level, "ui", message, details);
}

export function traceLog(level, src, msg, data) {
  return emit(level, src, msg, data);
}

export function setTraceLevel(level) {
  setLevel(level);
}

export { pinTraceSrc, setFollow as setTraceFollow };
