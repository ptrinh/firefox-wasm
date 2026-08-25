// A file picker for a browser that has no operating system under it.
//
// ══ WHY THERE ISN'T ONE ══
//
// `<input type="file">` does nothing in this engine, and not by omission of a
// small detail: `widget/moz.build` compiles `nsBaseFilePicker.cpp` only for
// gtk/cocoa/windows/android/uikit, and the wasm target's toolkit is `headless`
// (toolkit/moz.configure: "No native widget toolkit in wasm"). There is no
// `HeadlessFilePicker` either, so nothing implements `@mozilla.org/filepicker;1`
// and 15 of the 37 `abort("missing function: …")` stubs in the shipped glue are
// the base picker's vtable. Clicking an upload button is silence.
//
// ══ WHAT THIS IS ══
//
// The picker implemented where the files actually are: the HOST page. It needs
// no engine change at all, which is what makes it shippable — the alternative is
// C++ in the Gecko fork and a 2-4 hour engine rebuild per attempt.
//
// Three pieces:
//
//   1. A JS `nsIFilePicker`, registered in the engine's chrome by
//      `Components.manager` over `@mozilla.org/filepicker;1`. This is not a
//      trick: `testing/specialpowers/MockFilePicker.sys.mjs` has registered a
//      JS picker over that same contract for years, and this one is modelled on
//      it — including the part that matters, handing content real DOM `File`s
//      built in content's own global.
//
//   2. A panel in the host page with a REAL `<input type="file">`. The click on
//      it is a genuine user gesture on a genuine input, so the browser opens its
//      own file dialog with no permission dance. Auto-clicking a hidden input
//      from a timer was the obvious alternative and is the wrong one: the
//      gesture that reached the engine's canvas is long spent by the time the
//      engine asks, and Chrome refuses.
//
//   3. Two channels between them, both already in the build:
//        engine -> host   `evalChrome()`, polled — the engine has no way to call
//                         out, and adding one is the C++ change this avoids.
//        host -> engine   the bytes go through OPFS, which is already the
//                         profile mount, so the engine reads them as a local
//                         file. Base64 through `evalChrome` is the fallback for
//                         a browser with no OPFS, and is capped: it is JS SOURCE
//                         TEXT, parsed by an interpreter with no JIT.
//
// ══ WHAT THE USER GETS ══
//
// A file on their own computer, uploaded by a page whose network exits through
// the remote machine. The file never goes near the machine's disk, and the site
// sees only the machine's address.

/** Cross-realm-safe shape of what `Gecko` gives this module. */
export interface FilePickerDeps {
  /** Evaluates chrome JS in the engine and returns its stringified result. */
  evalChrome(js: string): Promise<string>;
  /** Where the panel is mounted; the engine's canvas parent. */
  host: HTMLElement;
  /**
   * The OPFS directory the engine has mounted as its profile, and the path it
   * appears at inside the engine. Null when the profile is a JS provider or
   * OPFS is unavailable — then bytes go inline and big files are refused.
   */
  opfs: { dir: string; guest: string } | null;
  /** How often the engine is asked whether a picker is waiting. */
  pollMs?: number;
  log?: (s: string) => void;
}

/** What the chrome-side picker reports when it wants a file. */
interface PickRequest {
  id: number;
  /** nsIFilePicker.Mode: 0 open, 1 save, 2 folder, 3 open-multiple. */
  mode: number;
  title: string;
  /** The `accept` attribute's filters, already raw (`.png`, `image/*`). */
  accept: string[];
}

/** One file, as the chrome side needs to hear about it. */
interface DeliveredFile {
  name: string;
  type: string;
  size: number;
  /** Path inside the engine, when the bytes went through OPFS. */
  path?: string;
  /** Base64 of the bytes, when they did not. */
  b64?: string;
}

/**
 * Inline transfer cap: 8 MB of bytes is ~11 MB of base64, and that base64 is
 * JS source text handed to an interpreter with no JIT (the wasm build disables
 * the JIT and runs the portable baseline interpreter). Past this it is not slow,
 * it is a hang, so it is refused with a reason instead.
 */
export const INLINE_LIMIT = 8 * 1024 * 1024;

/** Where picked files are parked inside the profile. */
export const PICKER_DIR = 'rk-filepicker';

/**
 * The chrome-side picker, as source text for `evalChrome`.
 *
 * Written as one expression that is safe to evaluate twice: the second
 * evaluation replaces the queue's owner rather than registering a second factory
 * for the same contract, which would leak the first.
 *
 * It deliberately does NOT reach for `Services.uuid` per instance or keep any
 * state on the window: everything lives on `globalThis.__rkFilePicker`, which is
 * also the only thing the host talks to.
 */
export const CHROME_BOOTSTRAP = String.raw`
(() => {
  const OK = 0, CANCEL = 1;
  // Re-evaluating must not register a second factory over the same contract.
  if (globalThis.__rkFilePicker) { globalThis.__rkFilePicker.reset(); return 'already'; }

  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const CONTRACT = '@mozilla.org/filepicker;1';
  const pending = [];          // requests the host has not collected yet
  const waiting = new Map();   // id -> { picker, callback }
  let nextId = 1;

  function Picker() {
    this._filters = [];
    this._files = [];          // DOM File objects, made in the content global
    this.filterIndex = 0;
    this.displayDirectory = null;
    this.displaySpecialDirectory = '';
    this.defaultString = '';
    this.defaultExtension = '';
    this.okButtonLabel = '';
    this.addToRecentDocs = false;
    this.capture = 0;
    this._mode = 0;
    this._title = '';
    this._window = null;
  }
  Picker.prototype = {
    QueryInterface: ChromeUtils.generateQI(['nsIFilePicker']),

    init(bc, title, mode, relevantGlobal) {
      this._mode = mode;
      this._title = title || '';
      // The global the File objects must belong to. Handing content a File from
      // the chrome global is the failure MockFilePicker's _toDomFile exists to
      // avoid: it is a foreign object and the page cannot read it.
      this._window = relevantGlobal || (bc && bc.window) || globalThis;
    },
    get mode() { return this._mode; },

    // Filters are collected, not applied here: the host input takes them as its
    // accept attribute and lets the real dialog do the filtering.
    appendFilter(title, filter) { if (filter) this._filters.push(filter); },
    appendRawFilter(filter) { if (filter) this._filters.push(filter); },
    appendFilters(mask) {
      // Only the masks a page can actually cause. Anything else -> everything.
      const M = Ci.nsIFilePicker;
      if (mask & M.filterImages) this._filters.push('image/*');
      if (mask & M.filterAudio) this._filters.push('audio/*');
      if (mask & M.filterVideo) this._filters.push('video/*');
      if (mask & M.filterHTML) this._filters.push('text/html');
      if (mask & M.filterText) this._filters.push('text/plain');
    },

    isModeSupported(mode) {
      // Open and open-multiple only. Save and folder-select need a real file
      // system to write into; saying so here is how the page finds out, instead
      // of a dialog that appears and cannot do anything.
      const supported = mode === 0 || mode === 3;
      return this._window && this._window.Promise
        ? this._window.Promise.resolve(supported)
        : Promise.resolve(supported);
    },

    get file() { return null; },     // there is no nsIFile: the bytes are a Blob
    get fileURL() { return null; },
    get files() { throw Components.Exception('', Cr.NS_ERROR_NOT_IMPLEMENTED); },
    get domFileOrDirectory() { return this._files[0] || null; },
    get domFileOrDirectoryEnumerator() {
      const files = this._files;
      return (function* () { for (const f of files) yield f; })();
    },
    get domFilesInWebKitDirectory() {
      throw Components.Exception('', Cr.NS_ERROR_NOT_IMPLEMENTED);
    },

    open(callback) {
      const id = nextId++;
      waiting.set(id, { picker: this, callback });
      pending.push({
        id,
        mode: this._mode,
        title: this._title,
        accept: this._filters.slice(),
      });
      // Nothing else: the host is polling, and the answer arrives at deliver().
    },
  };

  const factory = {
    createInstance(iid) { return new Picker().QueryInterface(iid); },
    QueryInterface: ChromeUtils.generateQI(['nsIFactory']),
  };
  const cid = Services.uuid.generateUUID();
  registrar.registerFactory(cid, 'RelayKey host file picker', CONTRACT, factory);

  function done(id, result) {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    try { entry.callback && entry.callback.done(result); } catch (e) { console.error(e); }
  }

  globalThis.__rkFilePicker = {
    /** One waiting request as JSON, or '' — the host's poll. */
    take() {
      return pending.length ? JSON.stringify(pending.shift()) : '';
    },

    /**
     * The user chose. payload is JSON: { id, files: [{name,type,size,path?,b64?}] }.
     *
     * Returns synchronously — evalChrome stringifies whatever this returns, so a
     * promise here would reach the host as "[object Promise]" and tell it
     * nothing. The work continues on its own and ends at done().
     */
    deliver(payload) {
      let req;
      try { req = JSON.parse(payload); } catch (e) { return 'badjson'; }
      const entry = waiting.get(req.id);
      if (!entry) return 'unknown';
      const picker = entry.picker;
      (async () => {
        try {
          const win = picker._window;
          const out = [];
          for (const f of req.files || []) {
            let bytes;
            if (f.path) {
              bytes = await IOUtils.read(f.path);
              // The copy in the profile is a transport, not a file the user
              // asked to keep. Removing it here rather than on a later sweep
              // keeps the profile from growing by every upload ever made.
              try { await IOUtils.remove(f.path); } catch (e) {}
            } else {
              const raw = atob(f.b64 || '');
              bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            }
            // Built in the CONTENT global, with a chrome Blob as the part: the
            // shape MockFilePicker uses for a File that came from elsewhere.
            const blob = new Blob([bytes], { type: f.type || '' });
            out.push(new win.File([blob], f.name || 'file', { type: f.type || '' }));
          }
          picker._files = out;
          done(req.id, out.length ? OK : CANCEL);
        } catch (e) {
          console.error('[rk-filepicker] deliver failed: ' + e);
          done(req.id, CANCEL);
        }
      })();
      return 'ok';
    },

    /** The user dismissed the panel, or the host gave up. */
    cancel(id) { done(id, CANCEL); return 'ok'; },

    /** How many pickers are still waiting for an answer. For diagnostics. */
    stats() { return JSON.stringify({ pending: pending.length, waiting: waiting.size }); },

    /** Drop every outstanding request, e.g. when the host reloads its side. */
    reset() {
      for (const id of Array.from(waiting.keys())) done(id, CANCEL);
      pending.length = 0;
      return 'ok';
    },
  };
  return 'installed';
})()
`;

/** Base64 without a data: URL round-trip, in chunks so the argument list is bounded. */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Write `bytes` into the profile's OPFS dir and return the engine-visible path. */
async function parkInOpfs(
  opfs: { dir: string; guest: string },
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const root = await navigator.storage.getDirectory();
  let dir = root;
  // The profile path may be nested ("gecko-profile" today, but not by contract).
  for (const part of opfs.dir.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const bucket = await dir.getDirectoryHandle(PICKER_DIR, { create: true });
  const handle = await bucket.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(bytes as unknown as BufferSource);
  await w.close();
  return `${opfs.guest}/${PICKER_DIR}/${name}`;
}

/** A file name that cannot escape the bucket or collide with another upload. */
export function safeName(id: number, index: number, name: string): string {
  const base = (name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(-64);
  return `${String(id)}-${String(index)}-${base}`;
}

/**
 * The panel: a real `<input type="file">` and nothing clever.
 *
 * Returns a dispose function. The click on the input is the user's own gesture
 * on a real input, which is the entire reason this is a visible panel and not a
 * hidden input clicked from the poll timer.
 */
export function showPanel(
  host: HTMLElement,
  req: PickRequest,
  onFiles: (files: File[]) => void,
  onCancel: () => void,
): () => void {
  const doc = host.ownerDocument;
  const wrap = doc.createElement('div');
  wrap.className = 'rk-filepicker';
  wrap.setAttribute(
    'style',
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(12,11,16,.72);z-index:2147483000;font:14px system-ui,sans-serif',
  );

  const card = doc.createElement('div');
  card.setAttribute(
    'style',
    'background:#26232e;color:#e8e6f2;padding:22px 24px;border-radius:12px;max-width:420px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:12px',
  );

  const h = doc.createElement('div');
  h.textContent = req.mode === 3 ? 'Choose files to upload' : 'Choose a file to upload';
  h.setAttribute('style', 'font-size:16px;font-weight:600');

  // Said plainly because it is the surprising part, and the reassuring one: the
  // file is read here and uploaded through the machine.
  const why = doc.createElement('div');
  why.textContent =
    'The file is read on this computer and uploaded through your remote machine, so the site sees the machine’s address.';
  why.setAttribute('style', 'color:#b8b3cc;line-height:1.55;font-size:12px');

  const input = doc.createElement('input');
  input.type = 'file';
  if (req.mode === 3) input.multiple = true;
  if (req.accept.length > 0) input.accept = req.accept.join(',');
  input.setAttribute('style', 'font:inherit;color:inherit');

  const row = doc.createElement('div');
  row.setAttribute('style', 'display:flex;gap:10px;align-items:center;justify-content:space-between');
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute(
    'style',
    'font:inherit;padding:7px 14px;border:0;border-radius:7px;background:#3a3646;color:#e8e6f2;cursor:pointer',
  );

  row.append(input, cancel);
  card.append(h, why, row);
  wrap.append(card);
  host.append(wrap);

  let done = false;
  const finish = (fn: () => void): void => {
    if (done) return;
    done = true;
    wrap.remove();
    fn();
  };

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return; // a dialog dismissed with nothing chosen
    finish(() => onFiles(files));
  });
  cancel.addEventListener('click', () => { finish(onCancel); });

  return () => { finish(() => undefined); };
}

/**
 * Install the picker. Returns a disposer.
 *
 * Never throws: an engine that cannot register the picker is an engine where
 * `<input type=file>` does nothing, which is exactly where it started.
 */
export function installFilePicker(deps: FilePickerDeps): () => void {
  const log = deps.log ?? ((s: string): void => console.log(s));
  const pollMs = deps.pollMs ?? 300;
  let stopped = false;
  let closePanel: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const deliver = async (req: PickRequest, files: File[]): Promise<void> => {
    const out: DeliveredFile[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i] as File;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const meta: DeliveredFile = { name: f.name, type: f.type, size: f.size };
      if (deps.opfs !== null) {
        meta.path = await parkInOpfs(deps.opfs, safeName(req.id, i, f.name), bytes);
      } else if (bytes.byteLength <= INLINE_LIMIT) {
        meta.b64 = toBase64(bytes);
      } else {
        // Refused with a reason rather than attempted: see INLINE_LIMIT.
        log(`[rk-filepicker] ${f.name} is ${String(bytes.byteLength)} bytes and this browser has no OPFS; refusing`);
        await deps.evalChrome(`__rkFilePicker.cancel(${String(req.id)})`);
        return;
      }
      out.push(meta);
    }
    const payload = JSON.stringify({ id: req.id, files: out });
    await deps.evalChrome(`__rkFilePicker.deliver(${JSON.stringify(payload)})`);
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Only when nothing is on screen: a second dialog over the first would ask
      // the user two questions at once and answer neither.
      if (closePanel === null) {
        const raw = await deps.evalChrome('__rkFilePicker.take()');
        if (raw !== '' && !raw.startsWith('EvalThrew')) {
          const req = JSON.parse(raw) as PickRequest;
          closePanel = showPanel(
            deps.host,
            req,
            (files) => {
              closePanel = null;
              void deliver(req, files).catch(async (e: unknown) => {
                log(`[rk-filepicker] delivery failed: ${String(e)}`);
                await deps.evalChrome(`__rkFilePicker.cancel(${String(req.id)})`);
              });
            },
            () => {
              closePanel = null;
              void deps.evalChrome(`__rkFilePicker.cancel(${String(req.id)})`);
            },
          );
        }
      }
    } catch (e) {
      log(`[rk-filepicker] poll failed: ${String(e)}`);
    }
    if (!stopped) timer = setTimeout(() => void poll(), pollMs);
  };

  void (async (): Promise<void> => {
    const res = await deps.evalChrome(CHROME_BOOTSTRAP);
    if (res.startsWith('EvalThrew')) {
      log(`[rk-filepicker] not installed: ${res}`);
      return;
    }
    log(`[rk-filepicker] ${res}; bytes go ${deps.opfs === null ? 'inline' : 'through OPFS'}`);
    void poll();
  })();

  return (): void => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (closePanel !== null) closePanel();
    closePanel = null;
  };
}
