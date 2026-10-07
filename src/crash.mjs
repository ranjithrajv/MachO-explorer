/**
 * crash.mjs — read an Apple crash report and say what the addresses in it are.
 *
 * ## Two formats, and both are still in the wild
 *
 * A crash report is one of two things depending on OS generation, and a reader
 * that handles one silently returns nothing useful on the other:
 *
 * - **`.ips`** (macOS 12 / iOS 15 onward). A one-line JSON header, a newline, then
 *   a JSON payload. `usedImages` carries every loaded image with its base address,
 *   and `threads[].frames[]` carry `imageIndex` + `imageOffset` — *relative* to
 *   that image, which is the part that matters: the numbers in the file are not
 *   addresses until a base is added.
 * - **`.crash`** (legacy text). A header of `Key: value` lines, a `Thread N Crashed:`
 *   block of `index  image  0xADDR  ...` lines, and a `Binary Images:` footer. Here
 *   the frames carry *absolute* addresses already, and the image is found by which
 *   range contains one.
 *
 * The two differ on the single most important question — whether a frame's number
 * is an address or an offset — so guessing wrong produces a confident answer about
 * the wrong instruction. The format is therefore stated in the result rather than
 * inferred, and the two parsers are separate rather than one with branches.
 *
 * ## What it refuses to do
 *
 * It does not invent a symbol. A frame whose image is not on disk resolves to
 * `null` naming the reason, because the honest answer for a modern macOS system
 * library is "this lives in the dyld shared cache and there is no file to read",
 * not a guess. The `symbol` a report already carries is reported as coming from the
 * *report*, never as something this package computed — the two have different
 * reliability and a caller has to be able to tell them apart.
 *
 * Unrecognised lines in a legacy report are counted and reported, for the same
 * reason `stub.mjs` does it: a half-parsed crash log that returns four frames when
 * there were forty is a well-formed wrong answer.
 */

/** The image a frame belongs to, or null. */
function imageAt(images, vaddr) {
  if (vaddr === null) return null;
  for (const img of images) {
    if (img.base === null || img.size === null) continue;
    if (vaddr >= img.base && vaddr < img.base + img.size) return img;
  }
  return null;
}

/** `0x…` for a BigInt, or null. */
const hx = (v) => (v === null || v === undefined ? null : `0x${BigInt(v).toString(16)}`);

function toBig(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
  // A string may be hex, or a decimal that already lost precision. `0x` is taken as
  // hex and anything else as decimal, because that is the only reading that cannot
  // silently reinterpret one as the other.
  const s = String(v).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  return null;
}

/**
 * Parse a modern `.ips` report: a JSON header line, then a JSON body.
 *
 * @throws with `code: 'unknown-encoding'` when either line is not the JSON it must
 *   be, because a report that does not parse is not a report with no frames.
 */
export function parseIps(text, source = '<ips>') {
  const nl = text.indexOf('\n');
  if (nl === -1) {
    throw Object.assign(new Error(`${source}: a .ips is a JSON header line and then a JSON body — this is one line`), { code: 'unknown-encoding' });
  }
  let header;
  let payload;
  try {
    header = JSON.parse(text.slice(0, nl));
  } catch (e) {
    throw Object.assign(new Error(`${source}: the first line is not valid JSON (${e.message})`), { code: 'unknown-encoding' });
  }
  try {
    payload = JSON.parse(text.slice(nl + 1));
  } catch (e) {
    throw Object.assign(new Error(`${source}: the body is not valid JSON (${e.message})`), { code: 'unknown-encoding' });
  }

  const rawImages = Array.isArray(payload.usedImages) ? payload.usedImages : [];
  const images = rawImages.map((im, i) => ({
    index: i,
    name: im.name ?? null,
    path: im.path ?? null,
    uuid: im.uuid ?? null,
    arch: im.arch ?? null,
    base: toBig(im.base),
    size: toBig(im.size),
  }));

  const rawThreads = Array.isArray(payload.threads) ? payload.threads : [];
  const threads = rawThreads.map((t, i) => ({
    index: i,
    id: t.id ?? null,
    name: t.name ?? null,
    queue: t.queue ?? null,
    triggered: Boolean(t.triggered),
    frames: (Array.isArray(t.frames) ? t.frames : []).map((f, j) => {
      const image = typeof f.imageIndex === 'number' ? images[f.imageIndex] ?? null : null;
      const off = toBig(f.imageOffset);
      // The base is added here and only here. Every downstream consumer gets an
      // address, so "is this field already absolute?" is answered once.
      const vaddr = image && image.base !== null && off !== null ? image.base + off : null;
      return {
        index: j,
        imageIndex: typeof f.imageIndex === 'number' ? f.imageIndex : null,
        imageOffset: off,
        vaddr,
        image: image ? (image.name ?? image.path) : null,
        // From the *report*, not from us. Named as such so a caller cannot mistake
        // a symbol Apple's reporter already had for one this package resolved.
        symbolFromReport: typeof f.symbol === 'string' ? f.symbol : null,
        symbolSource: typeof f.symbol === 'string' ? 'report' : null,
      };
    }),
  }));

  return {
    kind: 'ips',
    header: {
      app: header.app_name ?? payload.procName ?? null,
      version: header.app_version ?? null,
      os: header.os_version ?? null,
      bugType: header.bug_type ?? null,
      incidentId: header.incident_id ?? null,
      timestamp: header.timestamp ?? null,
      platform: header.platform ?? null,
    },
    exception: payload.exception ?? null,
    termination: payload.termination ?? null,
    faultingThread: typeof payload.faultingThread === 'number' ? payload.faultingThread : null,
    images,
    threads,
    unrecognised: [],
  };
}

/**
 * Parse a legacy text `.crash` report.
 *
 * ## Why this is line-based rather than regex-over-the-whole-file
 *
 * The sections are positional: a `Thread N Crashed:` header opens a frame block, and
 * a `Binary Images:` header closes the last one. Matching frame lines anywhere in
 * the file picks up the addresses in `Binary Images` as if they were frames — which
 * reads as a crash with hundreds of frames in libraries that were never on the
 * stack.
 */
export function parseLegacy(text, source = '<crash>') {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = {};
  const images = [];
  const threads = [];
  const unrecognised = [];

  let mode = 'header';
  let current = null;

  const FIELD = /^([A-Za-z][A-Za-z0-9 /_-]*):\s*(.*)$/;
  // `0   MyApp   0x0000000102a3c4d0 0x102a20000 + 115920`
  // `1   MyApp   0x0000000102a3c800 _main + 40`
  const FRAME = /^\s*(\d+)\s+(\S.*?)\s+(0x[0-9a-fA-F]+)\s+(.*)$/;
  // `0x102a20000 - 0x102a3ffff MyApp arm64  <uuid> /path`
  const IMAGE = /^\s*(0x[0-9a-fA-F]+)\s*-\s*(0x[0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(?:<([0-9a-fA-F-]+)>\s+)?(.*)$/;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (/^Thread\s+\d+\s+(Crashed|name:)/i.test(line)) {
      const idm = line.match(/^Thread\s+(\d+)/i);
      current = {
        index: threads.length,
        id: idm ? Number(idm[1]) : null,
        name: (line.match(/name:\s*(.*)$/i) || [])[1] ?? null,
        triggered: /Crashed/i.test(line),
        frames: [],
      };
      threads.push(current);
      mode = 'frames';
      continue;
    }
    if (/^Binary Images:/i.test(line)) { mode = 'images'; current = null; continue; }
    if (/^Thread\s+\d+/i.test(line)) {
      const idm = line.match(/^Thread\s+(\d+)/i);
      current = { index: threads.length, id: idm ? Number(idm[1]) : null, name: null, triggered: false, frames: [] };
      threads.push(current);
      mode = 'frames';
      continue;
    }

    if (mode === 'header') {
      const m = line.match(FIELD);
      if (m) {
        const key = m[1].trim();
        // First writer wins, so a repeated key does not overwrite the summary line.
        if (!(key in header)) header[key] = m[2].trim();
      } else if (line.trim() && !/^-+$/.test(line.trim())) {
        unrecognised.push({ line: raw, why: 'not a `Key: value` header line' });
      }
      continue;
    }

    if (mode === 'frames') {
      const m = line.match(FRAME);
      if (m) {
        const addr = toBig(m[3]);
        const rest = m[4].trim();
        // `0x102a20000 + 115920` is image-base-plus-offset; `_main + 40` is a symbol.
        const plus = rest.match(/^(\S+)\s*\+\s*(\d+)$/);
        const img = imageAtLegacy(images, addr);
        current.frames.push({
          index: current.frames.length,
          imageIndex: null,
          imageOffset: null,
          vaddr: addr,
          image: img ? img.name : (m[2] !== '???' ? m[2] : null),
          symbolFromReport: plus && !/^0x/i.test(plus[1]) ? plus[1] : null,
          symbolSource: plus && !/^0x/i.test(plus[1]) ? 'report' : null,
          frameText: rest,
        });
        continue;
      }
      // A `Thread N:` (non-crashed) block ends the frame run; anything else inside a
      // frame block that is not a frame is recorded rather than dropped.
      if (line.trim() && !/^$/u.test(line)) {
        unrecognised.push({ line: raw, why: `inside a frame block, matched no frame pattern` });
      }
      continue;
    }

    if (mode === 'images') {
      const m = line.match(IMAGE);
      if (m) {
        const base = toBig(m[1]);
        const end = toBig(m[2]);
        images.push({
          index: images.length,
          name: m[3],
          path: m[6] ? m[6].trim() : null,
          uuid: m[5] ?? null,
          arch: m[4],
          base,
          size: base !== null && end !== null ? end - base : null,
        });
      } else if (line.trim()) {
        unrecognised.push({ line: raw, why: 'inside Binary Images, matched no image pattern' });
      }
    }
  }

  // Second pass: the `Binary Images` footer comes *after* the frames in the file, so
  // a frame could not see its image while parsing. Resolving afterwards is what makes
  // the frame's owning image known at all.
  for (const t of threads) {
    for (const f of t.frames) {
      if (f.image) continue;
      const img = imageAtLegacy(images, f.vaddr);
      if (img) f.image = img.name;
    }
  }

  return {
    kind: 'legacy',
    header: {
      app: (header.Process ?? '').replace(/\s*\[[^\]]*\]\s*$/, '') || null,
      version: header.Version ?? null,
      os: header['OS Version'] ?? null,
      bugType: header['Exception Type'] ?? null,
      incidentId: header['Incident Identifier'] ?? null,
      timestamp: header['Date/Time'] ?? null,
      platform: header['Code Type'] ?? null,
    },
    exception: header['Exception Type']
      ? { type: header['Exception Type'], codes: header['Exception Codes'] ?? null }
      : null,
    termination: header['Termination Reason']
      ? { reason: header['Termination Reason'] }
      : null,
    faultingThread: (threads.find((t) => t.triggered) || {}).index ?? null,
    images,
    threads,
    rawHeader: header,
    unrecognised,
  };
}

/** Range lookup against legacy images, which may be built before the footer is read. */
function imageAtLegacy(images, vaddr) {
  return imageAt(images, vaddr);
}

/**
 * Read a crash report, choosing the parser by content rather than by extension.
 *
 * The extension is not trustworthy: `.ips` files are routinely saved as `.crash`
 * and vice versa, and a user who renamed one to open it in an editor did not
 * change what it is. Content decides, and the answer says which was used.
 */
export function parseCrash(text, source = '<crash>') {
  const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')).trim();
  if (first.startsWith('{') && first.endsWith('}')) {
    // A JSON first line is an `.ips` header — but only if it parses as one. Falling
    // back to the text parser rather than failing means a report that merely *starts*
    // with a brace still gets read.
    try { return parseIps(text, source); } catch { /* fall through to legacy */ }
  }
  return parseLegacy(text, source);
}

export { imageAt, toBig, hx };
