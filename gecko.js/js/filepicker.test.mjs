// Tests for the file picker, run with `node --test js` — no toolchain, no deps.
//
// Everything here is the half that cannot be reproduced on demand: a real run
// needs a cross-origin-isolated page, a 55 MB engine bundle and a person with a
// file to upload. What IS testable is every decision the code makes, and the
// most valuable target is the chrome-side bootstrap: it is a 170-line string
// that nothing else parses, so a typo in it reaches production as "the upload
// button still does nothing" — the exact symptom it was written to fix.
//
// The chrome API is stubbed rather than mocked away: Components.manager, Ci, the
// generateQI shim, IOUtils and a separate "content global" whose File
// constructor is a distinct class — because handing content a File from the
// chrome global is the mistake this design exists to avoid, and identity is how
// a test can see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHROME_BOOTSTRAP,
  INLINE_LIMIT,
  PICKER_DIR,
  installFilePicker,
  safeName,
  showPanel,
} from './filepicker.ts';

// --- the chrome side -------------------------------------------------------

/** Evaluate the bootstrap against a stub chrome; returns the pieces to drive. */
function chrome() {
  const registered = [];
  let factory = null;
  const g = {
    console: { error: () => {}, log: () => {} },
    Components: {
      manager: {
        QueryInterface: () => ({
          registerFactory: (cid, name, contract, f) => {
            registered.push(contract);
            factory = f;
          },
        }),
      },
      Exception: () => new Error('xpcom'),
    },
    Ci: {
      nsIComponentRegistrar: 1,
      nsIFactory: 1,
      nsIFilePicker: {
        filterImages: 0x08,
        filterAudio: 0x400,
        filterVideo: 0x800,
        filterHTML: 0x02,
        filterText: 0x04,
      },
    },
    Cr: { NS_ERROR_NOT_IMPLEMENTED: 0x80004001 },
    ChromeUtils: { generateQI: () => function () { return this; } },
    Services: { uuid: { generateUUID: () => '{cid}' } },
    IOUtils: {
      reads: [],
      removed: [],
      async read(path) { this.reads.push(path); return new Uint8Array([1, 2, 3]); },
      async remove(path) { this.removed.push(path); },
    },
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o?.type; } },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  g.globalThis = g;
  const run = new Function(
    'globalThis', 'Components', 'Ci', 'Cr', 'ChromeUtils', 'Services', 'IOUtils', 'Blob', 'atob', 'console',
    // Parenthesised: `return` followed by a newline is `return undefined`.
    `return (${CHROME_BOOTSTRAP})`,
  );
  const result = run(g, g.Components, g.Ci, g.Cr, g.ChromeUtils, g.Services, g.IOUtils, g.Blob, g.atob, g.console);
  // A DIFFERENT File class from the chrome one, so a File built in the wrong
  // global is a visible failure rather than a subtle one.
  const win = {
    File: class { constructor(parts, name, o) { this.parts = parts; this.name = name; this.type = o?.type; } },
    Promise,
  };
  return { g, api: g.__rkFilePicker, factory, registered, result, win, io: g.IOUtils };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

test('the bootstrap installs one picker over the real contract', () => {
  const c = chrome();
  assert.equal(c.result, 'installed');
  assert.deepEqual(c.registered, ['@mozilla.org/filepicker;1']);
  assert.equal(c.api.take(), '', 'nothing is waiting yet');
});

test('evaluating it twice does not register a second factory', () => {
  // It would leak the first one and leave two queues, only one of which the
  // host polls — an upload button that works every other time.
  const c = chrome();
  const again = new Function(
    'globalThis', 'Components', 'Ci', 'Cr', 'ChromeUtils', 'Services', 'IOUtils', 'Blob', 'atob', 'console',
    `return (${CHROME_BOOTSTRAP})`,
  )(c.g, c.g.Components, c.g.Ci, c.g.Cr, c.g.ChromeUtils, c.g.Services, c.g.IOUtils, c.g.Blob, c.g.atob, c.g.console);
  assert.equal(again, 'already');
  assert.equal(c.registered.length, 1);
});

test('opening a picker queues exactly what the host needs', () => {
  const c = chrome();
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, 'Upload an image', 3, c.win);
  p.appendFilters(c.g.Ci.nsIFilePicker.filterImages);
  p.appendRawFilter('.png');
  p.open({ done: () => {} });

  const req = JSON.parse(c.api.take());
  assert.equal(req.mode, 3);
  assert.equal(req.title, 'Upload an image');
  // The filters go to the host input's accept attribute; the real dialog does
  // the filtering, so they are passed through, not interpreted.
  assert.deepEqual(req.accept, ['image/*', '.png']);
  assert.equal(c.api.take(), '', 'a request is handed out once');
});

test('a delivered file becomes a File in the CONTENT global', async () => {
  const c = chrome();
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, '', 0, c.win);
  let result = null;
  p.open({ done: (r) => { result = r; } });
  const req = JSON.parse(c.api.take());

  assert.equal(
    c.api.deliver(JSON.stringify({
      id: req.id,
      files: [{ name: 'a.png', type: 'image/png', size: 3, path: '/opfs/p/rk-filepicker/1-0-a.png' }],
    })),
    'ok',
    'deliver answers synchronously — evalChrome would stringify a promise',
  );
  await settled();

  assert.equal(result, 0, 'returnOK');
  const f = p.domFileOrDirectory;
  assert.equal(f.constructor, c.win.File, 'built with the content global’s File');
  assert.equal(f.name, 'a.png');
  assert.equal(f.type, 'image/png');
  assert.equal([...p.domFileOrDirectoryEnumerator].length, 1);
  assert.deepEqual(c.io.reads, ['/opfs/p/rk-filepicker/1-0-a.png']);
  // The parked copy is a transport, not a file anyone asked to keep: left
  // behind, the profile grows by every upload ever made.
  assert.deepEqual(c.io.removed, ['/opfs/p/rk-filepicker/1-0-a.png']);
});

test('inline bytes work when there is no OPFS to park them in', async () => {
  const c = chrome();
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, '', 0, c.win);
  let result = null;
  p.open({ done: (r) => { result = r; } });
  const req = JSON.parse(c.api.take());
  c.api.deliver(JSON.stringify({
    id: req.id,
    files: [{ name: 'b.txt', type: 'text/plain', size: 2, b64: Buffer.from('hi').toString('base64') }],
  }));
  await settled();
  assert.equal(result, 0);
  assert.equal(c.io.reads.length, 0, 'no file was read: the bytes came in the message');
  assert.equal(p.domFileOrDirectory.name, 'b.txt');
});

test('a dismissed dialog is a cancel, not a hang', async () => {
  const c = chrome();
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, '', 0, c.win);
  let result = null;
  p.open({ done: (r) => { result = r; } });
  const req = JSON.parse(c.api.take());
  c.api.cancel(req.id);
  assert.equal(result, 1, 'returnCancel');
});

test('a failed read cancels rather than leaving the page waiting', async () => {
  const c = chrome();
  c.g.IOUtils.read = async () => { throw new Error('gone'); };
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, '', 0, c.win);
  let result = null;
  p.open({ done: (r) => { result = r; } });
  const req = JSON.parse(c.api.take());
  c.api.deliver(JSON.stringify({ id: req.id, files: [{ name: 'x', path: '/nope' }] }));
  await settled();
  assert.equal(result, 1, 'returnCancel');
});

test('nonsense from the host is refused without disturbing the queue', () => {
  const c = chrome();
  assert.equal(c.api.deliver('{{'), 'badjson');
  assert.equal(c.api.deliver(JSON.stringify({ id: 4242, files: [] })), 'unknown');
  assert.equal(c.api.cancel(4242), 'ok');
});

test('reset cancels everything outstanding', () => {
  // The host reloads its side; a picker left waiting would never be answered.
  const c = chrome();
  const results = [];
  for (const i of [0, 1]) {
    const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
    p.init(null, String(i), 0, c.win);
    p.open({ done: (r) => results.push(r) });
  }
  c.api.take();
  c.api.reset();
  assert.deepEqual(results, [1, 1]);
  assert.equal(JSON.parse(c.api.stats()).waiting, 0);
});

test('only open and open-multiple are claimed as supported', async () => {
  // Save and folder-select need a file system to write into. Claiming them gets
  // a dialog that appears and cannot do anything.
  const c = chrome();
  const p = c.factory.createInstance(c.g.Ci.nsIFilePicker);
  p.init(null, '', 1, c.win);
  assert.equal(await p.isModeSupported(0), true);
  assert.equal(await p.isModeSupported(3), true);
  assert.equal(await p.isModeSupported(1), false);
  assert.equal(await p.isModeSupported(2), false);
});

// --- the host side ---------------------------------------------------------

/** Just enough DOM for the panel: this is not a browser, only what it touches. */
function fakeDom() {
  const make = (tag) => {
    const el = {
      tagName: tag,
      children: [],
      listeners: {},
      attrs: {},
      style: '',
      textContent: '',
      removed: false,
      ownerDocument: null,
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
      append(...kids) { this.children.push(...kids); },
      remove() { this.removed = true; },
      fire(t) { for (const fn of this.listeners[t] ?? []) fn(); },
      find(pred) {
        if (pred(this)) return this;
        for (const k of this.children) {
          const hit = k.find?.(pred);
          if (hit) return hit;
        }
        return null;
      },
      get text() {
        return this.textContent + this.children.map((k) => k.text ?? '').join(' ');
      },
    };
    return el;
  };
  const doc = { createElement: make };
  const host = make('div');
  host.ownerDocument = doc;
  const patch = (el) => { el.ownerDocument = doc; return el; };
  doc.createElement = (t) => patch(make(t));
  return { doc, host };
}

test('the panel offers a real file input, not a hidden one', () => {
  // The whole reason there is a visible panel: the click on the input IS the
  // user gesture. A hidden input clicked from the poll timer is refused by
  // Chrome, because the gesture that reached the canvas is long spent.
  const { host } = fakeDom();
  showPanel(host, { id: 1, mode: 3, title: '', accept: ['image/*'] }, () => {}, () => {});
  const input = host.find((e) => e.type === 'file');
  assert.ok(input, 'there is a file input');
  assert.equal(input.multiple, true, 'open-multiple asks for multiple');
  assert.equal(input.accept, 'image/*');
  assert.match(host.text, /Choose files to upload/);
  // And it says where the file goes, which is the surprising part.
  assert.match(host.text, /uploaded through your remote machine/);
});

test('a single-file picker does not offer multiple', () => {
  const { host } = fakeDom();
  showPanel(host, { id: 1, mode: 0, title: '', accept: [] }, () => {}, () => {});
  const input = host.find((e) => e.type === 'file');
  assert.notEqual(input.multiple, true);
  assert.equal(input.accept, undefined, 'no accept attribute when nothing was asked for');
});

test('choosing nothing is not an answer', () => {
  // A native dialog dismissed with Escape fires `change` with an empty list on
  // some browsers. Treating that as a pick hands the page zero files and calls
  // it success.
  const { host } = fakeDom();
  let called = 0;
  showPanel(host, { id: 1, mode: 0, title: '', accept: [] }, () => { called += 1; }, () => {});
  const input = host.find((e) => e.type === 'file');
  input.files = [];
  input.fire('change');
  assert.equal(called, 0);
});

test('cancel closes the panel and says so once', () => {
  const { host } = fakeDom();
  let cancels = 0;
  const close = showPanel(host, { id: 1, mode: 0, title: '', accept: [] }, () => {}, () => { cancels += 1; });
  const button = host.find((e) => e.tagName === 'button');
  button.fire('click');
  assert.equal(cancels, 1);
  // Disposing an already-closed panel must not report a second cancel: the
  // picker would be answered twice, and the second answer overrides the first.
  close();
  assert.equal(cancels, 1);
});

test('installFilePicker gives up quietly when the engine refuses the bootstrap', async () => {
  // An engine that cannot register the picker is an engine where <input
  // type=file> does nothing — exactly where it started. It must not throw into
  // the middle of startup.
  const said = [];
  const dispose = installFilePicker({
    evalChrome: () => Promise.resolve('EvalThrew: no chrome global'),
    host: fakeDom().host,
    opfs: null,
    log: (s) => said.push(s),
  });
  await settled();
  dispose();
  assert.match(said.join('\n'), /not installed/);
});

test('installFilePicker polls, shows a panel, and delivers what was chosen', async () => {
  const { host } = fakeDom();
  const seen = [];
  let served = false;
  const dispose = installFilePicker({
    evalChrome: (js) => {
      seen.push(js);
      if (js.includes('__rkFilePicker.take()')) {
        if (served) return Promise.resolve('');
        served = true;
        return Promise.resolve(JSON.stringify({ id: 7, mode: 0, title: '', accept: [] }));
      }
      return Promise.resolve('ok');
    },
    host,
    opfs: null,
    pollMs: 1,
    log: () => {},
  });

  // Wait for the panel rather than assuming a tick count.
  let input = null;
  for (let i = 0; i < 200 && input === null; i += 1) {
    await settled();
    input = host.find((e) => e.type === 'file');
  }
  assert.ok(input, 'the panel appeared');

  input.files = [{
    name: 'note.txt',
    type: 'text/plain',
    size: 2,
    arrayBuffer: async () => new TextEncoder().encode('hi').buffer,
  }];
  input.fire('change');
  for (let i = 0; i < 200; i += 1) {
    await settled();
    if (seen.some((s) => s.includes('__rkFilePicker.deliver('))) break;
  }
  dispose();

  const call = seen.find((s) => s.includes('__rkFilePicker.deliver('));
  assert.ok(call, 'the choice reached the engine');
  // The bytes are inline here (no OPFS in this test) and base64, not a path.
  const payload = JSON.parse(JSON.parse(call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'))));
  assert.equal(payload.id, 7);
  assert.equal(payload.files[0].name, 'note.txt');
  assert.equal(Buffer.from(payload.files[0].b64, 'base64').toString(), 'hi');
});

test('an oversized file with no OPFS is refused with a reason, not attempted', async () => {
  // Base64 of 8 MB is ~11 MB of JS SOURCE TEXT, parsed by an interpreter with
  // no JIT. Past the cap it is not slow, it is a hang.
  const { host } = fakeDom();
  const seen = [];
  let served = false;
  const said = [];
  const dispose = installFilePicker({
    evalChrome: (js) => {
      seen.push(js);
      // Matched on the full call: the bootstrap SOURCE also contains "take()",
      // and a looser match answers the install with a request nobody asked for.
      if (js.includes('__rkFilePicker.take()')) {
        if (served) return Promise.resolve('');
        served = true;
        return Promise.resolve(JSON.stringify({ id: 9, mode: 0, title: '', accept: [] }));
      }
      return Promise.resolve('ok');
    },
    host,
    opfs: null,
    pollMs: 1,
    log: (s) => said.push(s),
  });

  let input = null;
  for (let i = 0; i < 200 && input === null; i += 1) {
    await settled();
    input = host.find((e) => e.type === 'file');
  }
  const big = new Uint8Array(INLINE_LIMIT + 1);
  input.files = [{ name: 'big.bin', type: '', size: big.byteLength, arrayBuffer: async () => big.buffer }];
  input.fire('change');
  for (let i = 0; i < 300; i += 1) {
    await settled();
    if (seen.some((s) => s.includes('__rkFilePicker.cancel('))) break;
  }
  dispose();

  assert.ok(seen.some((s) => s.includes('__rkFilePicker.cancel(9)')), 'the picker was answered');
  // The full call, again: the bootstrap source itself contains the word.
  assert.ok(!seen.some((s) => s.includes('__rkFilePicker.deliver(')), 'and nothing was sent');
  assert.match(said.join('\n'), /no OPFS; refusing/);
});

test('parked file names cannot escape their bucket', () => {
  assert.equal(safeName(3, 1, '../../etc/passwd'), '3-1-.._.._etc_passwd');
  assert.equal(safeName(1, 0, ''), '1-0-file');
  assert.ok(safeName(1, 0, 'x'.repeat(500)).length < 100);
  assert.equal(PICKER_DIR, 'rk-filepicker');
});
