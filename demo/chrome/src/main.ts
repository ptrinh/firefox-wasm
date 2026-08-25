import { Gecko, type FsProvider } from "gecko.js";
import "./styles.css";
import {
  prepareChromeFs,
  PROFILE_OPFS_PATH,
  type ChromeAssetsProgress,
} from "./chrome-fs";

// Injected by vite.config (define): the served engine wasm { url, compressed }.
declare const __GECKO_WASM__: { url: string; compressed: boolean };
declare global {
  interface ImportMeta {
    env: {
      VITE_PUTER_BRANDING?: string;
      VITE_DISABLE_BRANDING?: string;
    };
  }
}

// VITE_DISABLE_BRANDING strips the Firefox logo: the hero tile (and the "×"
// connector, leaving just the WebAssembly mark) plus the favicon, which uses
// the same artwork.
if (import.meta.env.VITE_DISABLE_BRANDING) {
  document.querySelector(".firefox-tile")?.remove();
  document.querySelector(".logo-x")?.remove();
  document.getElementById("favicon")?.remove();
}

const canvas = document.getElementById("screen") as HTMLCanvasElement;
const splash = document.getElementById("splash") as HTMLElement;
const splashShell = document.getElementById("splash-shell") as HTMLElement;
const stageCard = document.getElementById("stage-card") as HTMLElement;
const stage = document.querySelector(".stage") as HTMLElement;
const status = document.getElementById("splash-status") as HTMLElement;
const phase = document.getElementById("progress-phase") as HTMLElement;
const percent = document.getElementById("progress-percent") as HTMLElement;
const fill = document.getElementById("progress-fill") as HTMLElement;
const progressbar = document.querySelector(".progress-track") as HTMLElement;
const consoleOutput = document.getElementById("console-output") as HTMLElement;

type UiPhase = "loading" | "ready" | "console";
function setUiPhase(next: UiPhase): void {
  splashShell.dataset.phase = next;
  stageCard.dataset.phase = next;
  stage.dataset.phase = next;
}

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const MAX_CONSOLE_LINES = 300;

function stringifyConsoleArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function appendConsoleLine(
  level: "log" | "warn" | "error",
  args: unknown[],
): void {
  const line = document.createElement("div");
  line.className = `console-line ${level}`;

  const prefix = document.createElement("span");
  prefix.className = "console-prefix";
  prefix.textContent = `[${level}] `;
  line.append(prefix, args.map(stringifyConsoleArg).join(" "));

  consoleOutput.appendChild(line);
  while (consoleOutput.childElementCount > MAX_CONSOLE_LINES) {
    consoleOutput.firstElementChild?.remove();
  }
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

console.log = (...args: unknown[]) => {
  appendConsoleLine("log", args);
  nativeConsole.log(...args);
};
console.warn = (...args: unknown[]) => {
  appendConsoleLine("warn", args);
  nativeConsole.warn(...args);
};
console.error = (...args: unknown[]) => {
  appendConsoleLine("error", args);
  nativeConsole.error(...args);
};

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function setProgress(p: ChromeAssetsProgress): void {
  const pct =
    p.percent == null ? undefined : Math.max(0, Math.min(1, p.percent));
  status.textContent =
    p.loaded && p.total
      ? `${p.message} · ${formatBytes(p.loaded)} / ${formatBytes(p.total)}`
      : p.message;
  phase.textContent = p.phase[0].toUpperCase() + p.phase.slice(1);
  if (pct == null) {
    progressbar.removeAttribute("aria-valuenow");
    percent.textContent = "";
    return;
  }
  const rounded = Math.round(pct * 100);
  fill.style.width = `${rounded}%`;
  progressbar.setAttribute("aria-valuenow", String(rounded));
  percent.textContent = `${rounded}%`;
}

const BROWSER_CHROME_URL = "chrome://browser/content/browser.xhtml";

// The Vite dev/preview server runs a WISP proxy at /wisp/ on this same origin
// (see vite.config.ts). Default the engine's WISP endpoint to it so the chrome
// front-end can load sites in tabs out of the box. Resolved RELATIVE to the
// page URL (the build uses vite base './' so a deploy can live in any
// subdirectory, with its wisp proxy next to it).
const wispUrl = new URL("wisp/", location.href);
wispUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const defaultWisp = wispUrl.href;

// ── The WISP endpoint is ALWAYS the one serving this page ────────────────────
//
// Upstream has a `VITE_PUTER_BRANDING` build flag that replaces the endpoint with
// one fetched from a hosted service, and ignores the user's own setting while it
// is on. In the published v0.0.1 bundle that flag is compiled to `true`, so every
// page the browser loads leaves from that third party's network.
//
// It is measurable: on a machine whose own connection egresses in Singapore, this
// browser reported a Comcast address in Texas. For a tool whose entire purpose is
// that traffic leaves from the machine you control, that is not a branding
// choice — it is the opposite of the feature, and it is silent.
//
// The branch is deleted rather than defaulted to off. A flag that can be flipped
// back by an environment variable at build time is one nobody will notice being
// flipped; the endpoint is now derived from `location.href` with no way to
// override it from outside the page.
const puterBranding = false;

// Engine options are consumed when the engine boots (GECKO_GPU / GECKO_NOWASMJIT
// are read once at init, WISP installs in preRun). Init only happens on the
// Start click, so the controls are read (and persisted) right then -- no reload.
const LS_KEY = "chrome-demo-opts";
interface Opts {
  gpu: boolean;
  jit: boolean;
  wisp: string;
}
const saved: Partial<Opts> = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
const opts: Opts = {
  gpu: saved.gpu ?? true, // GPU acceleration on by default
  jit: saved.jit ?? false, // wasm JIT off by default (GECKO_NOWASMJIT set)
  wisp: puterBranding ? defaultWisp : (saved.wisp ?? defaultWisp),
};

const gpuToggle = document.getElementById("opt-gpu") as HTMLInputElement;
const jitToggle = document.getElementById("opt-jit") as HTMLInputElement;
const wispInput = document.getElementById("opt-wisp") as HTMLInputElement;
const advanced = document.querySelector(".advanced") as HTMLDetailsElement;
if (puterBranding) {
  stageCard.classList.add("puter-branded");
  wispInput.disabled = true;
}
gpuToggle.checked = opts.gpu;
jitToggle.checked = opts.jit;
wispInput.value = opts.wisp;

// Read the current control values, persisting them for the next visit.
function collectOpts(): Opts {
  const next: Opts = {
    gpu: gpuToggle.checked,
    jit: jitToggle.checked,
    wisp: puterBranding ? defaultWisp : wispInput.value.trim(),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}

// GPU is presence-gated; with GPU on, also route content WebGL to a real host GL
// context (GECKO_GL_PASSTHROUGH). The wasm JIT is on unless GECKO_NOWASMJIT is set.
function buildEnv(o: Opts): Record<string, string> {
  const optEnv: Record<string, string> = { GECKO_CHROME: "1" };
  if (o.gpu) {
    optEnv.GECKO_GPU = "1";
    optEnv.GECKO_GL_PASSTHROUGH = "1";
    // In-process WebRender display-list handoff (skip the content->compositor IPDL
    // Pickle round-trip). Opt-in engine flag (GECKO_WR_DIRECT).
    optEnv.GECKO_WR_DIRECT = "1";
    // Async pan/zoom (correctly targets nested scroll containers via the
    // GetDocument/SetTargetAPZC fix).
    optEnv.GECKO_APZ = "1";
  }
  if (!o.jit) optEnv.GECKO_NOWASMJIT = "1";

  // Generic `?env.FOO=bar` knob (mirrors embed-demo): forward arbitrary engine env
  // vars from the URL, e.g. ?env.GECKO_WASM_INTERP=1 to run content WebAssembly in
  // the in-process interpreter instead of the host passthrough.
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (k.startsWith("env.")) optEnv[k.slice(4)] = v;
  }
  return optEnv;
}

// --- Auto asset prep on load, explicit-Launch engine init -----------------
// The browser assets start downloading + decompressing immediately on page
// load (no gating click). Once they're ready the panel shows a single Launch
// button: the emscripten/Gecko init stays gated behind that click because it
// spins up the audio AudioWorklet, and the click is the user gesture browsers
// require before audio (and other gesture-gated APIs) can start.
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

// The engine needs WebAssembly JSPI (the GPU present path suspends on it, wired
// into the glue at link time) -- without it the wasm won't run. Feature-detect
// and keep Launch greyed out when it's missing; Firefox has JSPI behind an
// about:config flag, so give Firefox users the recipe.
const hasJspi =
  typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function" &&
  typeof (WebAssembly as { promising?: unknown }).promising === "function";
if (!hasJspi) {
  const note = document.getElementById("jspi-note") as HTMLElement;
  note.textContent =
    "This browser doesn't support WebAssembly JSPI, which Firefox WASM needs to run.";
  if (navigator.userAgent.includes("Firefox")) {
    const hint = document.createElement("span");
    hint.append(
      " To enable it in Firefox: open ",
      Object.assign(document.createElement("code"), {
        textContent: "about:config",
      }),
      ", set ",
      Object.assign(document.createElement("code"), {
        textContent: "javascript.options.wasm_js_promise_integration",
      }),
      " to ",
      Object.assign(document.createElement("code"), { textContent: "true" }),
      ", then reload this page.",
    );
    note.append(hint);
  }
  note.hidden = false;
}

function fail(e: unknown): void {
  console.error("[chrome-demo] startup failed", e);
  setUiPhase("console");
  startBtn.disabled = false;
  startBtn.textContent = "Retry";
  startBtn.onclick = () => location.reload();
}

// Launch is only actionable once the assets have finished loading.
startBtn.onclick = () => void start();
startBtn.disabled = true;
setUiPhase("loading");

// --- combined download progress --------------------------------------------
// The chrome-assets archive and the engine wasm download concurrently and share
// the single progress bar (summed bytes across both). Non-download updates from
// the assets side (decompressing/ready) pass through only once the wasm is also
// in; until then the bar keeps tracking the combined download.
const dl = {
  assets: { loaded: 0, total: 0 },
  wasm: { loaded: 0, total: 0, done: false },
};

function renderDownloads(): void {
  const loaded = dl.assets.loaded + dl.wasm.loaded;
  const total =
    dl.assets.total && dl.wasm.total
      ? dl.assets.total + dl.wasm.total
      : undefined;
  setProgress({
    phase: "downloading",
    loaded,
    total,
    percent: total ? loaded / total : undefined,
    message: "Downloading Firefox",
  });
}

function assetsProgress(p: ChromeAssetsProgress): void {
  if (p.phase === "downloading") {
    dl.assets.loaded = p.loaded ?? dl.assets.loaded;
    dl.assets.total = p.total ?? dl.assets.total;
  } else {
    // The assets download is over (decompress/install underway): count it fully.
    if (dl.assets.total) dl.assets.loaded = dl.assets.total;
    if (dl.wasm.done) {
      setProgress(p);
      return;
    }
  }
  renderDownloads();
}

// Optimistic engine-wasm prefetch, started at page load in parallel with the
// chrome assets: stream it down with progress, then hand gecko.init() a blob:
// URL so the loader's own wasm fetch resolves instantly from memory. The blob
// is typed application/wasm so instantiateStreaming still accepts it (the
// release .zst goes through the loader's arrayBuffer+zstd path regardless).
async function fetchWasmBlob(): Promise<string> {
  const url = new URL(__GECKO_WASM__.url, location.href).href;
  const r = await fetch(url);
  if (!r.ok || !r.body)
    throw new Error(`engine wasm fetch failed (${r.status}) for ${url}`);
  dl.wasm.total = Number(r.headers.get("Content-Length")) || 0;
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    dl.wasm.loaded += value.byteLength;
    renderDownloads();
  }
  dl.wasm.done = true;
  if (!dl.wasm.total) dl.wasm.total = dl.wasm.loaded;
  renderDownloads();
  return URL.createObjectURL(
    new Blob(chunks as BlobPart[], { type: "application/wasm" }),
  );
}

// Both kicked off immediately so the big downloads (~18 MB assets + the engine
// wasm) overlap the time the user spends reading the page. chromeFsReady
// resolves to the in-memory tar FsProvider handed to gecko.init() on Launch;
// wasmBlobReady to the blob: URL for the engine wasm.
const chromeFsReady: Promise<FsProvider> = prepareChromeFs(assetsProgress);
const wasmBlobReady: Promise<string> = fetchWasmBlob();
Promise.all([chromeFsReady, wasmBlobReady])
  .then(() => {
    console.log("[chrome-demo] chrome assets + engine wasm ready");
    setUiPhase("ready");
    // Stays greyed out (never enabled) when the browser lacks JSPI.
    startBtn.disabled = !hasJspi;
  })
  .catch(fail);

async function start(): Promise<void> {
  setUiPhase("console");
  startBtn.disabled = true;
  gpuToggle.disabled = true;
  jitToggle.disabled = true;
  wispInput.disabled = true;
  // Collapse the advanced options so the startup log has room without scrolling.
  advanced.open = false;
  startBtn.textContent = "Starting…";

  const chosen = collectOpts();
  const optEnv = buildEnv(chosen);

  // GECKO_CHROME=1 makes the engine use /gre/browser as its APP dir and register
  // the browser chrome package. We still explicitly load browser.xhtml after init;
  // that load is what creates the top-level Firefox chrome window.
  // The chrome assets are already downloaded + decompressed into memory (the
  // Download phase above), so gecko.init() reads them straight from the
  // in-memory tar.
  const gecko = new Gecko({
    canvas,
    // Fill the viewport; a debounced window-resize listener keeps it in sync (below).
    width: window.innerWidth,
    height: window.innerHeight,
    // The engine wasm was prefetched into memory at page load (its download is
    // part of the progress bar); hand the loader the blob: URL so its own
    // fetch resolves instantly. Launch is only enabled once wasmBlobReady
    // resolved, so this await is instant.
    wasm: {
      url: await wasmBlobReady,
      compressed: __GECKO_WASM__.compressed,
    },
    env: optEnv,
    // GRE: an FsProvider over the in-memory decompressed tar (consulted
    // provider-first for /gre, baked gecko.data as fallback). Profile:
    // persistent OPFS at `${PROFILE_OPFS_PATH}`.
    // Launch is only enabled once chromeFsReady resolved, so this is instant.
    fs: await chromeFsReady,
    profile: PROFILE_OPFS_PATH,
    // The chrome UI itself boots from local files; loading sites in tabs goes
    // through the WISP endpoint (defaults to the dev server's /wisp/ proxy).
    wispUrl: chosen.wisp.trim() || undefined,
    print: (s) => console.log("[gecko]", s),
    printErr: (s) => console.warn("[gecko]", s),
  });

  try {
    await gecko.init();
    console.log("init done");
    setProgress({
      phase: "ready",
      percent: 1,
      message: "Loading browser chrome",
    });
    console.log("[chrome-demo] loading browser chrome");
    await gecko.load(BROWSER_CHROME_URL);
    console.log("[chrome-demo] Firefox front-end booted");
    // Three bookmarks, and the removal of two that are not ours.
    //
    // The two upstream entries — "Puter Developer" and "Firefox WASM Github" —
    // are about the project that built the engine, not about anything the
    // operator is doing here. An earlier version of this comment said they were
    // gone; they were not. They do not come from this file at all: they are
    // inside the prebuilt profile in chrome-assets.tar.zst, which is
    // byte-identical to upstream's. Seeding only ever ADDED, so they survived
    // every release and showed up on the toolbar next to ours.
    //
    // Removed by URL rather than by clearing the toolbar. Clearing is simpler and
    // is what the seed gate would make safe on a fresh profile — but the gate has
    // been re-versioned before, and a re-seed that wipes a toolbar someone has
    // arranged is not a mistake they can undo. Named URLs only touch what upstream
    // shipped.
    //
    // No favicons. The upstream entries carried base64 icons fetched from the
    // sites they pointed at; seeding one would make the browser reach out to a
    // third party before the operator has asked for anything.
    const UPSTREAM_BOOKMARK_HOSTS = ["puter.com", "developer.puter.com", "github.com"];
    const PRELOADED_BOOKMARKS = [
      {
        // The homepage, kept reachable after someone navigates away: what this
        // browser is, where its traffic exits, and where its profile lives.
        title: "RelayKey Browser Guide",
        url: "https://relaykey.net/how/firefox",
        guid: "relaykey0005",
      },
      {
        title: "BrowserLeaks IP",
        url: "https://browserleaks.com/ip",
        guid: "relaykey0001",
      },
      {
        title: "IPFighter",
        url: "https://ipfighter.com/",
        guid: "relaykey0002",
      },
      {
        title: "QuantumProxies IP Checker",
        url: "https://quantumproxies.io/ip-checker",
        guid: "relaykey0003",
      },
      {
        // The replacement for installing this automatically. It points at the
        // add-on's own page, where the ordinary Add to Firefox button does the
        // work — no special path, nothing here to keep in step with AMO.
        title: "Get uBlock Origin",
        url: "https://addons.mozilla.org/firefox/addon/ublock-origin/",
        guid: "relaykey0004",
      },
    ];

    await gecko.evalChrome(`(() => {
      const seed = async () => {
        const SEEDED_PREF = 'chrome-demo.bookmarks.seeded.relaykey4';
        if (Services.prefs.getBoolPref(SEEDED_PREF, false)) return;
        const bookmarks = ${JSON.stringify(PRELOADED_BOOKMARKS)};
        const strangers = ${JSON.stringify(UPSTREAM_BOOKMARK_HOSTS)};
        // Before inserting, so the toolbar is never briefly both.
        try {
          const tree = await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.toolbarGuid);
          for (const child of (tree && tree.children) || []) {
            if (!child.uri) continue;
            let host = '';
            try { host = Services.io.newURI(child.uri).host; } catch (e) { continue; }
            if (strangers.includes(host)) {
              await PlacesUtils.bookmarks.remove(child.guid).catch(() => {});
            }
          }
        } catch (e) {
          // A toolbar we cannot read is not a reason to skip seeding ours.
          console.log('[chrome-demo] bookmarks: could not read the toolbar:', e);
        }
        // Only the ones that are not already there.
        //
        // The pref is bumped whenever this list changes, so an existing profile
        // re-runs this to pick up a new entry — and insertTree throws on a guid
        // that already exists, which would abandon the whole seed and deliver
        // nothing. Filtering first makes a re-seed add exactly what is new.
        const fresh = [];
        for (const bm of bookmarks) {
          const already = await PlacesUtils.bookmarks.fetch({ guid: bm.guid }).catch(() => null);
          if (!already) fresh.push(bm);
        }
        if (fresh.length) {
          await PlacesUtils.bookmarks.insertTree({
            guid: PlacesUtils.bookmarks.toolbarGuid,
            children: fresh.map(bm => ({ title: bm.title, url: bm.url, guid: bm.guid })),
          });
        }
        // No favicon seeding: these entries carry none, and Services.io.newURI
        // would throw on undefined rather than skip.
        for (const bm of bookmarks) {
          if (!bm.favicon || !bm.faviconURL) continue;
          const pageURI = Services.io.newURI(bm.url);
          const faviconURI = Services.io.newURI(bm.favicon);
          const faviconURL = Services.io.newURI(bm.faviconURL);
          await PlacesUtils.favicons.setFaviconForPage(
            pageURI,
            faviconURI,
            faviconURL,
            Date.now() * 1000 + 365 * 24 * 3600 * 1e6
          );
        };
        Services.prefs.setBoolPref(SEEDED_PREF, true);
        setTimeout(() => BookmarkingUI.updateEmptyToolbarMessage().catch(() => {}), 250);
      };
      const { PlacesBrowserStartup } = ChromeUtils.importESModule(
        'moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs');
      if (PlacesBrowserStartup._placesBrowserInitComplete) { seed(); return 'seeded-now'; }
      const o = () => {
        Services.obs.removeObserver(o, 'places-browser-init-complete');
        seed();
      };
      Services.obs.addObserver(o, 'places-browser-init-complete');
      return 'seed-deferred';
    })()`);

    // ── Homepage, IPv6 and WebRTC ────────────────────────────────────────────
    //
    // Set as DEFAULT prefs (getDefaultBranch), not user prefs: a default is what
    // the browser falls back to and what "Restore Defaults" returns to, and it
    // leaves anything the operator changes themselves as a user pref that wins.
    // Writing user prefs here would silently overwrite their choice on every boot.
    //
    // `browser.startup.page = 1` is what makes the homepage actually open — the
    // pref alone only decides what the Home button goes to.
    //
    // IPv6 and WebRTC are on deliberately. This browser exists so that traffic
    // leaves from the MACHINE rather than from the operator's own connection, and
    // both of these are ways an address can differ from the one a site sees. The
    // engine has no real network interface: every socket, v4 or v6, TCP or UDP, is
    // dialled by the agent at the far end of the WISP tunnel — so turning them on
    // widens what works without widening what leaks. Turning IPv6 OFF, by
    // contrast, would make a v6-only host unreachable for no privacy gain.
    await gecko.evalChrome(`(() => {
      const d = Services.prefs.getDefaultBranch('');
      d.setStringPref('browser.startup.homepage', 'https://relaykey.net/how/firefox');
      d.setIntPref('browser.startup.page', 1);
      // IPv6 resolution and connection. Firefox disables v6 DNS on some
      // platforms by default; the tunnel carries either family.
      d.setBoolPref('network.dns.disableIPv6', false);
      // WebRTC. Its UDP rides the same tunnel, so candidates reflect the machine.
      d.setBoolPref('media.peerconnection.enabled', true);
      d.setBoolPref('media.peerconnection.ice.default_address_only', false);
      // The bookmarks toolbar is off by default. It costs a row of a window
      // that is already someone's whole screen, and the bookmarks are still
      // there — the menu reaches them, and Ctrl+B (Cmd+B through the key
      // translation) brings the bar back for anyone who wants it. A DEFAULT
      // branch pref, so a reader who turns it on keeps it on.
      d.setStringPref('browser.toolbars.bookmarks.visibility', 'never');
      return 'prefs-set';
    })()`);

    // uBlock Origin is NOT installed here, and that is a reversal.
    //
    // It used to be fetched and installed on first boot. The download and the
    // addon manager's work both happen while the engine is starting, on the same
    // thread that draws it, so the browser sat frozen for about thirty seconds
    // before anyone could type an address. Every launch of a fresh profile paid
    // that, to deliver something not everyone wants.
    //
    // The reasoning for having it was sound and is unchanged: every request
    // crosses the WISP tunnel and, on a relayed path, is billed by the byte at
    // both ends, so blocking is bandwidth policy and not just taste. What was
    // wrong was taking that decision on the operator's behalf, before they had
    // asked for anything, at the cost of the first half-minute.
    //
    // So it is a bookmark now (see PRELOADED_BOOKMARKS). One click, when they
    // want it, on a page that installs it the ordinary way — and a browser that
    // opens immediately for everyone who does not.

    await gecko.evalChrome(
      `setToolbarVisibility(document.getElementById('PersonalToolbar'), 'always'); 'ok'`,
    );

    // Default the search engine to DuckDuckGo. Seeded once (localStorage-gated)
    // so a user picking a different engine later isn't overridden on the next
    // visit. This Firefox has no Services.search (the search service is a plain
    // ESM singleton now); import it via moz-src. Fire-and-forget behind its
    // async init(). (Key is -v2: v1 was burned by a broken seed attempt.)
    const SEARCH_SEEDED_KEY = "chrome-demo-search-seeded-v2";
    if (!localStorage.getItem(SEARCH_SEEDED_KEY)) {
      localStorage.setItem(SEARCH_SEEDED_KEY, "1");
      void gecko.evalChrome(`(() => {
        (async () => {
          const { SearchService } = ChromeUtils.importESModule(
            'moz-src:///toolkit/components/search/SearchService.sys.mjs');
          await SearchService.init();
          const engine = SearchService.getEngineByName('DuckDuckGo');
          if (!engine) throw new Error('DuckDuckGo engine not found');
          await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
          console.log('search seed: default is now ' + (await SearchService.getDefault()).name);
        })().catch(e => console.error('search seed: ' + e));
        return 'search-seed-started';
      })()`);
    }

    // Autoload the default page into the FIRST tab (the one browser.xhtml opened
    // at startup, still selected at this point). Only this initial tab is driven;
    // new tabs (Ctrl+T / +) keep the regular about:newtab. Not awaited so the
    // chrome appears immediately while the page loads.
    //
    // Reads the homepage PREF rather than repeating a URL. This line is what
    // actually decides the page you see — setting browser.startup.homepage without
    // changing it here would look like the pref had no effect, because a hardcoded
    // second copy silently wins. One source of truth, and changing the pref is now
    // enough.
    void gecko.evalChrome(
      `openTrustedLinkIn(
         Services.prefs.getStringPref('browser.startup.homepage', 'about:blank'),
         'current'); 'ok'`,
    );

    canvas.classList.add("ready");
    splash.classList.add("done");
    canvas.focus();

    // Debug/test hook: open a site in a tab from the console (mirrors embed-demo's
    // window.geckoLoad). The chrome's own address bar is the normal way in.
    (window as unknown as { geckoLoad: (u: string) => unknown }).geckoLoad = (
      u,
    ) => gecko.load(u);
    (
      window as unknown as { geckoEvalChrome: (js: string) => Promise<string> }
    ).geckoEvalChrome = (js) => gecko.evalChrome(js);

    // Keep the engine sized to the viewport. The window may have changed during the
    // (slow) boot, so correct once now, then track resizes with a ~200ms debounce
    // (resize reflows + recomposites the whole chrome, so coalesce bursts).
    await gecko.resize(window.innerWidth, window.innerHeight);
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(
        () => gecko.resize(window.innerWidth, window.innerHeight),
        200,
      );
    });
  } catch (e) {
    fail(e);
  }
}
