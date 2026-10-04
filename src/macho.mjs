/**
 * macho.mjs — a Mach-O reader.
 *
 * Fat-header parsing, load commands, symbol tables, `__TEXT` literal search and
 * file-offset-to-vaddr mapping. It knows nothing about any application; it knows
 * about the file format.
 *
 * ## Why this is one module
 *
 * These tools were written one at a time and each grew its own reader. They
 * diverged, and the divergence produced bugs that no amount of testing on the
 * binary the tools were written for would have found:
 *
 *   - one tool hardcoded `const SLICE = 0x4000` — one binary's x86_64 slice
 *     offset inside its own fat header, correct for exactly one file on earth.
 *     Against any other universal binary it read load commands out of the middle
 *     of a data section and returned a confident, wrong answer.
 *   - another read the architecture list at a fixed offset, which is only right
 *     for a *thin* Mach-O, so on a universal binary its section walk silently
 *     failed and it scanned a default window containing nothing.
 *   - a third treated an absent architecture as fatal rather than a preference,
 *     so it failed outright on an arm64-only binary.
 *
 * Every one of those is a *parse* bug, and they were only reachable by pointing
 * a tool at a binary it was not written for. Centralising the parsing is what
 * makes them fixable once.
 *
 * ## Why the fat header is parsed rather than assumed
 *
 * A universal binary's slices sit at offsets given by the fat header, and those
 * offsets depend on the order and number of architectures in the build. There
 * is no default, and the numbers vary far enough to matter: in one measured
 * pair the slices sat at 0x4000 and 0xf16c000. A reader that assumed 0x4000
 * would work on that binary and nowhere else.
 *
 * ## Which slice to use
 *
 * Not "the first one". A universal binary can be stripped on one architecture
 * and not the other, so `richestSlice` takes the one with the most symbols and
 * `preferredSlice` treats a requested architecture as a preference that falls
 * back to the richest rather than a requirement that returns null.
 */

import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Mach-O and fat-header magics, big- and little-endian. */
export const MH_MAGIC_64 = 0xfeedfacf;
export const MH_MAGIC_32 = 0xfeedface;
export const FAT_MAGIC = 0xcafebabe;
export const FAT_CIGAM = 0xbebafeca;

export const LC_SEGMENT = 0x1;
export const LC_SYMTAB = 0x2;
export const LC_SEGMENT_64 = 0x19;
export const LC_UUID_CMD = 0x1b;
export const LC_RPATH_CMD = 0x1c;

/**
 * The commands that record which platform a binary was built for.
 *
 * `LC_BUILD_VERSION` is the current form and the only one a modern linker emits; the
 * four `LC_VERSION_MIN_*` commands are its predecessor, still emitted by older
 * toolchains for the platforms that predate it. All five are decoded, because a
 * `LC_VERSION_MIN_IPHONEOS` in the wild means the binary's platform is knowable and a
 * reader that only understood `LC_BUILD_VERSION` would report nothing for it — the
 * "recognised but silent" failure this project treats as worse than a refusal.
 *
 * The `LC_VERSION_MIN_*` commands name their platform in the *command* rather than in
 * a field, which is why they need a map instead of a comparison against one value.
 */
export const LC_BUILD_VERSION_CMD = 0x32;
/** The pair that records FairPlay encryption state. Same 20-byte struct in both. */
export const LC_ENCRYPTION_INFO_CMD = 0x21;
export const LC_ENCRYPTION_INFO_64_CMD = 0x2c;
export const VERSION_MIN_COMMANDS = new Map([
  [0x24, 'macos'],
  [0x25, 'ios'],
  [0x2f, 'tvos'],
  [0x30, 'watchos'],
]);


/**
 * `LC_REQ_DYLD`, the bit that marks a command the loader must understand.
 *
 * Several commands are *defined* with this bit set — `LC_MAIN` is `0x28 |
 * LC_REQ_DYLD`, not `0x28` — and the bit is part of the command's identity rather
 * than a decoration on it. A reader that matches the bare `0x28` misses the only
 * form a real binary emits. See {@link LC_MAIN_CMD}.
 */
export const LC_REQ_DYLD = 0x80000000;

/**
 * The commands whose payload is a `struct dylib_command`.
 *
 * All six share one layout, so they are one entry in the decoder rather than six:
 *
 *     struct dylib_command {
 *         uint32_t cmd;                 // one of the six below
 *         uint32_t cmdsize;
 *         union lc_str dylib;           // lc_str = a uint32 *offset* from cmd
 *         uint32_t timestamp;
 *         uint32_t current_version;
 *         uint32_t compatibility_version;
 *     };
 *
 * The last four differ only in what the loader does with the name, and that
 * difference is the reason they cannot be collapsed into one value: a
 * `LC_LOAD_WEAK_DYLIB` that is absent is fine, a missing `LC_LOAD_DYLIB` is a
 * broken install, and `LC_REEXPORT_DYLIB` also re-exports the named image's
 * symbols into the client. Reporting all three as "linked against" would be the
 * kind of flattening this reader exists to avoid, so the linkage is carried
 * through as its own value.
 *
 * `LC_ID_DYLIB` is in {@link DYLIB_ID_CMD}, not here: it names *this* image
 * rather than a dependency, so it is the install name rather than a link.
 *
 * The `LC_REQ_DYLD` forms are the ones a real binary emits for the four marked
 * commands, and the bare values name different commands entirely — `0x18` is
 * `LC_LOAD_WEAK_DYLIB` in `<mach-o/loader.h>`'s *enumeration*, but only the
 * `0x80000018` form is a dylib command on disk. Both are listed in
 * {@link loadCommandName}; only the `0x80000000` ones are decoded here, because
 * accepting the bare value would decode a command the linker never emits.
 *
 * `>>> 0` on the three `LC_REQ_DYLD` keys is load-bearing and not decoration. `|`
 * is a *signed* 32-bit operation in JavaScript, so `0x18 | 0x80000000` evaluates
 * to `-2147483624`, not `2147483640` — and `cmd` arrives from `readUInt32LE` as an
 * unsigned value, so the lookup would miss every weak and re-export dylib in the
 * file while appearing to work for `LC_LOAD_DYLIB` itself, which needs no mask.
 * The same idiom is already used for {@link LC_MAIN_CMD}.
 */
export const DYLIB_COMMANDS = new Map([
  [0x0c, { linkage: 'load' }],
  [(0x18 | LC_REQ_DYLD) >>> 0, { linkage: 'weak' }],
  [(0x1f | LC_REQ_DYLD) >>> 0, { linkage: 'reexport' }],
  [0x20, { linkage: 'lazy' }],
  [(0x23 | LC_REQ_DYLD) >>> 0, { linkage: 'upward' }],
]);

/**
 * `LC_ID_DYLIB`, which names this image's own install name.
 *
 * Separate from {@link DYLIB_COMMANDS} because it answers a different question.
 * A dependency is "what must be present for this to load"; an install name is
 * "what this file calls itself", which is what a dylib's own `LC_ID_DYLIB`
 * records so that clients linking against it record the right name. It is the
 * same struct and therefore the same decoder, and it is what `otool -D` prints.
 */
export const DYLIB_ID_CMD = 0x0d;

/**
 * The entry point, in the form a compiled binary actually declares.
 *
 * `<mach-o/loader.h>` defines `LC_MAIN` as `(0x28 | LC_REQ_DYLD)`. This constant
 * is that value, and it is the value the comparison in `parseThin` must use: the
 * bare `0x28` names nothing, and the command that *does* sit at bare `0x29` is
 * `LC_DATA_IN_CODE`, a `linkedit_data_command` whose `dataoff` is a file offset
 * into `__LINKEDIT`. Reading that as an entry point yields an `entryoff` that
 * looks like an offset and is not one.
 */
export const LC_MAIN = 0x28;
// `>>> 0` because `|` is a signed 32-bit operation in JavaScript: `0x28 | 0x80000000`
// is the negative number -2147483608, while `readUInt32LE` hands back the unsigned
// 2147483688. Comparing the two would never match.
export const LC_MAIN_CMD = (LC_MAIN | LC_REQ_DYLD) >>> 0;

/** `LC_SOURCE_VERSION`: the source revision, packed `a24.b10.c10.d10.e10`. */
export const LC_SOURCE_VERSION_CMD = 0x2a;

/** `LC_FUNCTION_STARTS`: ULEB128 deltas of function start addresses. */
export const LC_FUNCTION_STARTS_CMD = 0x26;

/** `LC_DATA_IN_CODE`: file ranges that are data rather than instructions. */
export const LC_DATA_IN_CODE_CMD = 0x29;

/**
 * Load-command names, for `describe --loads`.
 *
 * A *description* table, deliberately. It exists so `parseThin` can print what a
 * binary declares without this reader having to understand what any of it means
 * — the line between "this file says it links libSystem" and "this reader can
 * resolve libSystem" is the project's own "will not do" boundary, and naming the
 * commands does not cross it. `LC_ENCRYPTION_INFO` is in here for the same
 * reason: knowing a binary is encrypted is a fact about it.
 *
 * Keys are the numeric commands; the `0x80000000` bit is stripped first, because
 * `LC_REQ_DYLD` only ever *adds* to a base command and every consumer here wants
 * the base name. An unmapped command is reported by number rather than dropped,
 * so an unrecognised load command is visible instead of silently absent.
 */
export const LOAD_COMMANDS = {
  0x1: 'LC_SEGMENT',
  0x2: 'LC_SYMTAB',
  0x3: 'LC_SYMSEG',
  0x4: 'LC_THREAD',
  0x5: 'LC_UNIXTHREAD',
  0x6: 'LC_LOADFVMLIB',
  0x7: 'LC_IDFVMLIB',
  0x8: 'LC_IDENT',
  0x9: 'LC_FVMFILE',
  0xa: 'LC_PREPAGE',
  0xb: 'LC_DYSYMTAB',
  0xc: 'LC_LOAD_DYLIB',
  0xd: 'LC_ID_DYLIB',
  0xe: 'LC_LOAD_DYLINKER',
  0xf: 'LC_ID_DYLINKER',
  0x10: 'LC_PREBOUND_DYLIB',
  0x11: 'LC_ROUTINES',
  0x12: 'LC_SUB_FRAMEWORK',
  0x13: 'LC_SUB_UMBRELLA',
  0x14: 'LC_SUB_CLIENT',
  0x15: 'LC_SUB_LIBRARY',
  0x16: 'LC_TWOLEVEL_HINTS',
  0x17: 'LC_PREBIND_CKSUM',
  0x18: 'LC_LOAD_WEAK_DYLIB',
  0x19: 'LC_SEGMENT_64',
  0x1a: 'LC_ROUTINES_64',
  0x1b: 'LC_UUID',
  0x1c: 'LC_RPATH',
  0x1d: 'LC_CODE_SIGNATURE',
  0x1e: 'LC_SEGMENT_SPLIT_INFO',
  0x1f: 'LC_REEXPORT_DYLIB',
  0x20: 'LC_LAZY_LOAD_DYLIB',
  0x21: 'LC_ENCRYPTION_INFO',
  0x22: 'LC_DYLD_INFO',
  0x23: 'LC_LOAD_UPWARD_DYLIB',
  0x24: 'LC_VERSION_MIN_MACOSX',
  0x25: 'LC_VERSION_MIN_IPHONEOS',
  0x26: 'LC_FUNCTION_STARTS',
  0x27: 'LC_DYLD_ENVIRONMENT',
  0x28: 'LC_MAIN',
  0x29: 'LC_DATA_IN_CODE',
  0x2a: 'LC_SOURCE_VERSION',
  0x2b: 'LC_DYLIB_CODE_SIGN_DRS',
  0x2c: 'LC_ENCRYPTION_INFO_64',
  0x2d: 'LC_LINKER_OPTION',
  0x2e: 'LC_LINKER_OPTIMIZATION_HINT',
  0x2f: 'LC_VERSION_MIN_TVOS',
  0x30: 'LC_VERSION_MIN_WATCHOS',
  0x31: 'LC_NOTE',
  0x32: 'LC_BUILD_VERSION',
  0x33: 'LC_DYLD_EXPORTS_TRIE',
  0x34: 'LC_DYLD_CHAINED_FIXUPS',
  0x35: 'LC_FILESET_ENTRY',
  0x36: 'LC_ATOM_INFO',
  0x37: 'LC_FUNCTION_VARIANTS',
  0x38: 'LC_FUNCTION_VARIANT_FIXUPS',
  0x39: 'LC_TARGET_TRIPLE',
};

/**
 * Commands whose `LC_REQ_DYLD` form has a *different* name from the bare value.
 *
 * Stripping the `0x80000000` bit is right for `LC_RPATH` (`0x1c` and
 * `0x8000001c` are the same command), but wrong for these: `LC_MAIN` is *defined*
 * as `0x28 | LC_REQ_DYLD`, and the bare `0x28` names nothing. Without this map,
 * `0x80000028` strips to `0x28` and the reader either prints a number or — if the
 * table also carried a `0x28` entry — would name it by the wrong command.
 */
const REQ_DYLD_NAMES = {
  0x80000018: 'LC_LOAD_WEAK_DYLIB',
  0x8000001f: 'LC_REEXPORT_DYLIB',
  0x80000022: 'LC_DYLD_INFO_ONLY',
  0x80000023: 'LC_LOAD_UPWARD_DYLIB',
  0x80000028: 'LC_MAIN',
  0x80000033: 'LC_DYLD_EXPORTS_TRIE',
  0x80000034: 'LC_DYLD_CHAINED_FIXUPS',
  0x80000035: 'LC_FILESET_ENTRY',
};

/** Name a load command, or report its number when no table has an entry. */
export function loadCommandName(cmd) {
  // The exact `LC_REQ_DYLD` form is checked first, because for the commands in
  // REQ_DYLD_NAMES the bit is part of the name rather than decoration on it. Only
  // then is the bit stripped, which is the right rule for everything else and for
  // `LC_RPATH` in particular (`0x8000001c` is LC_RPATH, not a distinct command).
  return REQ_DYLD_NAMES[cmd] || LOAD_COMMANDS[cmd & 0x7fffffff] || `0x${(cmd >>> 0).toString(16)}`;
}

/** nlist_64 type field: N_STAB and N_TYPE masks. */
export const N_STAB = 0xe0;
export const N_TYPE = 0x0e;
export const N_SECT = 0x0e;

export const CPU_X86_64 = 0x01000007;
export const CPU_ARM64 = 0x0100000c;
export const CPU_ARM64_32 = 0x0200000c;
export const CPU_POWERPC = 0x00000012;
export const CPU_POWERPC64 = 0x01000012;

/**
 * Section attribute bits that mark a section as containing instructions.
 *
 * These are the flags a linker sets on `__text` and `__stubs`, and *only* on
 * those. They are what makes a scan typed: everything else in `__TEXT` is data
 * or literals, and a byte pattern that happens to decode as a call inside
 * `__cstring` is not a call site no matter how plausible it looks.
 */
export const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;
export const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;

/* ------------------------------------------------------------------ *
 * header flags
 * ------------------------------------------------------------------ */

/**
 * The `flags` word of `mach_header`/`mach_header_64`, byte 24, as `[bit, name]`.
 *
 * Transcribed from `<mach-o/loader.h>` in the macOS SDK rather than from memory,
 * and the header is a worse source of assumptions than it looks. Four of these
 * are newer than the "28 flags" usually quoted for `MH_*`: `MH_NLIST_OUTOFSYNC_
 * WITH_DYLDINFO`, `MH_SIM_SUPPORT`, `MH_IMPLICIT_PAGEZERO` and `MH_DYLIB_IN_CACHE`.
 * A table that stopped at `MH_APP_EXTENSION_SAFE` would report those four as
 * unknown bits on real binaries — which is precisely the false alarm the
 * abnormality check in {@link detectAbnormalities} must not be able to raise.
 *
 * The bits are *not* contiguous: 0x20000000 has no name in the header at all,
 * so a binary that sets it produces a genuinely unknown bit. That gap is the
 * reason {@link decodeHeaderFlags} reports `unknown` bits separately from
 * undecoded ones rather than folding them together.
 */
export const MH_FLAGS = [
  [0x00000001, 'MH_NOUNDEFS'],
  [0x00000002, 'MH_INCRLINK'],
  [0x00000004, 'MH_DYLDLINK'],
  [0x00000008, 'MH_BINDATLOAD'],
  [0x00000010, 'MH_PREBOUND'],
  [0x00000020, 'MH_SPLIT_SEGS'],
  [0x00000040, 'MH_LAZY_INIT'],
  [0x00000080, 'MH_TWOLEVEL'],
  [0x00000100, 'MH_FORCE_FLAT'],
  [0x00000200, 'MH_NOMULTIDEFS'],
  [0x00000400, 'MH_NOFIXPREBINDING'],
  [0x00000800, 'MH_PREBINDABLE'],
  [0x00001000, 'MH_ALLMODSBOUND'],
  [0x00002000, 'MH_SUBSECTIONS_VIA_SYMBOLS'],
  [0x00004000, 'MH_CANONICAL'],
  [0x00008000, 'MH_WEAK_DEFINES'],
  [0x00010000, 'MH_BINDS_TO_WEAK'],
  [0x00020000, 'MH_ALLOW_STACK_EXECUTION'],
  [0x00040000, 'MH_ROOT_SAFE'],
  [0x00080000, 'MH_SETUID_SAFE'],
  [0x00100000, 'MH_NO_REEXPORTED_DYLIBS'],
  [0x00200000, 'MH_PIE'],
  [0x00400000, 'MH_DEAD_STRIPPABLE_DYLIB'],
  [0x00800000, 'MH_HAS_TLV_DESCRIPTORS'],
  [0x01000000, 'MH_NO_HEAP_EXECUTION'],
  // `0x02000000`, not `0x00200000` — the bit above `MH_NO_HEAP_EXECUTION`, with a
  // leading zero in the header. Reading it as 24 would report a real flag as
  // unknown and invent a different one alongside it.
  [0x02000000, 'MH_APP_EXTENSION_SAFE'],
  [0x04000000, 'MH_NLIST_OUTOFSYNC_WITH_DYLDINFO'],
  [0x08000000, 'MH_SIM_SUPPORT'],
  [0x10000000, 'MH_IMPLICIT_PAGEZERO'],
  [0x80000000, 'MH_DYLIB_IN_CACHE'],
];

/** Every named header-flag bit, as one mask. The complement is what may be unknown. */
const MH_FLAG_MASK = MH_FLAGS.reduce((a, [bit]) => a | bit, 0);

/**
 * Decode a header `flags` word into names, plus any bits this table cannot name.
 *
 * `unknown` is the whole point of the return value. A flag bit that is set and
 * unnamed is either a format newer than this reader or a corrupted header, and
 * those two deserve very different reactions — so it is reported rather than
 * dropped. Dropping it would make a file that declares something unfamiliar look
 * exactly like one that does not, which is the shape of a wrong answer.
 *
 * @param {number} flags the `flags` word, as read unsigned
 * @returns {{flags: number, names: string[], unknown: number}}
 */
export function decodeHeaderFlags(flags) {
  const names = [];
  for (const [bit, name] of MH_FLAGS) {
    if ((flags & bit) !== 0) names.push(name);
  }
  // `~MH_FLAG_MASK` is negative in two's complement, so it is masked back to 32
  // bits before use. `flags` is already unsigned, so this cannot go negative.
  const unknown = (flags & ~MH_FLAG_MASK) >>> 0;
  return { flags, names, unknown };
}

/* ------------------------------------------------------------------ *
 * section types and attributes
 * ------------------------------------------------------------------ */

/** `SECTION_TYPE`, the low byte of a section's `flags`. */
export const SECTION_TYPE_MASK = 0x000000ff;

/**
 * Section types, the low byte of a section's `flags`.
 *
 * Transcribed from `<mach-o/loader.h>`, and complete through
 * `S_INIT_FUNC_OFFSETS` (0x16) — including the five thread-local types, which a
 * 22-entry table copied from an older header omits, and which appear on any
 * binary built with C++ static destructors or `thread_local` variables.
 */
export const SECTION_TYPES = {
  0x00: 'S_REGULAR',
  0x01: 'S_ZEROFILL',
  0x02: 'S_CSTRING_LITERALS',
  0x03: 'S_4BYTE_LITERALS',
  0x04: 'S_8BYTE_LITERALS',
  0x05: 'S_LITERAL_POINTERS',
  0x06: 'S_NON_LAZY_SYMBOL_POINTERS',
  0x07: 'S_LAZY_SYMBOL_POINTERS',
  0x08: 'S_SYMBOL_STUBS',
  0x09: 'S_MOD_INIT_FUNC_POINTERS',
  0x0a: 'S_MOD_TERM_FUNC_POINTERS',
  0x0b: 'S_COALESCED',
  0x0c: 'S_GB_ZEROFILL',
  0x0d: 'S_INTERPOSING',
  0x0e: 'S_16BYTE_LITERALS',
  0x0f: 'S_DTRACE_DOF',
  0x10: 'S_LAZY_DYLIB_SYMBOL_POINTERS',
  0x11: 'S_THREAD_LOCAL_REGULAR',
  0x12: 'S_THREAD_LOCAL_ZEROFILL',
  0x13: 'S_THREAD_LOCAL_VARIABLES',
  0x14: 'S_THREAD_LOCAL_VARIABLE_POINTERS',
  0x15: 'S_THREAD_LOCAL_INIT_FUNCTION_POINTERS',
  0x16: 'S_INIT_FUNC_OFFSETS',
};

/**
 * Section attributes, the top 24 bits of a section's `flags`, as `[bit, name]`.
 *
 * `S_ATTR_PURE_INSTRUCTIONS` and `S_ATTR_SOME_INSTRUCTIONS` are here as entries
 * rather than kept only as the two constants {@link isCodeSection} tests, because
 * a section's attributes are now *reported* and the two lists must not be able
 * to disagree about which bits those are. {@link isCodeSection} still tests the
 * constants — the single source of truth for the code/data decision — and this
 * table is the single source of truth for the names.
 *
 * Note the hole in the numbering: `S_ATTR_DEBUG` is 0x02000000 and the bits below
 * it are 0x00000400 downward, so 0x01000000 through 0x00800000 and 0x00008000
 * downward have no name. Those become `attributesUnknown`, and are reported.
 */
export const SECTION_ATTRIBUTES = [
  [0x80000000, 'S_ATTR_PURE_INSTRUCTIONS'],
  [0x40000000, 'S_ATTR_NO_TOC'],
  [0x20000000, 'S_ATTR_STRIP_STATIC_SYMS'],
  [0x10000000, 'S_ATTR_NO_DEAD_STRIP'],
  [0x08000000, 'S_ATTR_LIVE_SUPPORT'],
  [0x04000000, 'S_ATTR_SELF_MODIFYING_CODE'],
  [0x02000000, 'S_ATTR_DEBUG'],
  [0x00000400, 'S_ATTR_SOME_INSTRUCTIONS'],
  [0x00000200, 'S_ATTR_EXT_RELOC'],
  [0x00000100, 'S_ATTR_LOC_RELOC'],
];

const SECTION_ATTRIBUTE_MASK = SECTION_ATTRIBUTES.reduce((a, [bit]) => a | bit, 0);

/**
 * The attribute *region* of a section's `flags`: `SECTION_ATTRIBUTES`, the top 24.
 *
 * Separate from {@link SECTION_ATTRIBUTE_MASK}, which is only the bits this table
 * can name — and the two are not interchangeable. Masking with the complement of
 * the named bits and calling the remainder "unknown attributes" also catches the
 * section *type* in the low byte, so every `S_CSTRING_LITERALS` section reported
 * `0x2` as an unknown attribute and every real binary came back with a wall of
 * spurious warnings. The region has to be bounded first, and only then compared
 * against the names.
 */
const SECTION_ATTRIBUTE_REGION = 0xffffff00;

/**
 * Split a section's `flags` word into its type and its attributes.
 *
 * The two occupy disjoint parts of one word — `SECTION_TYPE` is the low 8 bits,
 * `SECTION_ATTRIBUTES` the top 24 — and they answer different questions. Type
 * says what the bytes are (`S_CSTRING_LITERALS`, `S_SYMBOL_STUBS`);
 * attributes say how the linker may treat them (`S_ATTR_PURE_INSTRUCTIONS`,
 * `S_ATTR_NO_DEAD_STRIP`). `code`/`data` in the section listing comes from the
 * attributes, and the type is printed beside it, so a section can be read as
 * "code" and `S_REGULAR` at once — which is what `__text` is.
 *
 * @param {number} flags the section's `flags` word, as read unsigned
 * @returns {{type: string, typeRaw: number, attributes: string[], attributesUnknown: number}}
 */
export function decodeSectionFlags(flags) {
  const typeRaw = flags & SECTION_TYPE_MASK;
  const attributes = [];
  for (const [bit, name] of SECTION_ATTRIBUTES) {
    if ((flags & bit) !== 0) attributes.push(name);
  }
  const attributesUnknown = (flags & SECTION_ATTRIBUTE_REGION & ~SECTION_ATTRIBUTE_MASK) >>> 0;
  return {
    type: SECTION_TYPES[typeRaw] || `S_UNKNOWN_0x${typeRaw.toString(16)}`,
    typeRaw,
    attributes,
    attributesUnknown,
  };
}

/* ------------------------------------------------------------------ *
 * LC_SOURCE_VERSION
 * ------------------------------------------------------------------ */

/**
 * Decode an `LC_SOURCE_VERSION` word into its five components.
 *
 * The header documents this as `A.B.C.D.E packed as a24.b10.c10.d10.e10`, which
 * is not five equal fields — `A` is 24 bits and the rest are 10. Decoding it as
 * five 10-bit fields, which is the obvious reading and the one most tools get
 * wrong, silently mangles every component: a real `A` of 0x1000000 would lose its
 * high bits and the whole version would come out as `0.0.0.x.y`. So the shifts
 * are taken from that comment rather than derived.
 *
 * @param {bigint} v the packed `version` word
 * @returns {{raw: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, text: string}}
 */
export function decodeSourceVersion(v) {
  const a = (v >> 40n) & 0xffffffn;
  const b = (v >> 30n) & 0x3ffn;
  const c = (v >> 20n) & 0x3ffn;
  const d = (v >> 10n) & 0x3ffn;
  const e = v & 0x3ffn;
  return { raw: v, a, b, c, d, e, text: `${a}.${b}.${c}.${d}.${e}` };
}

/**
 * `platform`, as `LC_BUILD_VERSION` records it.
 *
 * Transcribed from `<mach-o/loader.h>` in the installed SDK — read, not recalled.
 * That matters more here than for most of these tables, because **the numbering has
 * changed**. `PLATFORM_MACOS` was `6` before 2017 and is `1` now; `PLATFORM_IOS` was
 * `7` and is `2`. The first table written here used the old numbering, and it was
 * caught by running it rather than by reading it back: every macOS binary on the
 * machine reports `1`, and the table confidently called that `v1`. A table recalled
 * from memory is worse than no table, because a missing name at least announces
 * itself.
 *
 * The modern numbering is contiguous from 1 to 12, so the early values are a plain
 * list — but they are still a table, because 13 onward are not contiguous: `PLATFORM_FIRMWARE`
 * is 13, `PLATFORM_SEPOS` is 14, and then sixteen `EXCLAVECORE`/`EXCLAVEKIT` pairs
 * run to 24. The pairs are generated rather than written out, and the generation is
 * visible so that a reader can see what it is derived from.
 *
 * `PLATFORM_ANY` (0xFFFFFFFF) is a wildcard a *client* records rather than a platform
 * a binary is built for. It is named, and `decodePlatform` marks it unrecognised as a
 * platform even though it has a name — see below.
 */
export const PLATFORMS = {
  0: 'unknown',
  1: 'macos',
  2: 'ios',
  3: 'tvos',
  4: 'watchos',
  5: 'bridgeos',
  6: 'maccatalyst',
  7: 'ios-simulator',
  8: 'tvos-simulator',
  9: 'watchos-simulator',
  10: 'driverkit',
  11: 'visionos',
  12: 'visionos-simulator',
  13: 'firmware',
  14: 'sepos',
  ...Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => i * 2 + 15).flatMap((n, i) => [
      [n, ['macos', 'ios', 'tvos', 'watchos', 'visionos'][i] + '-exclavecore'],
      [n + 1, ['macos', 'ios', 'tvos', 'watchos', 'visionos'][i] + '-exclavekit'],
    ]),
  ),
  0xffffffff: 'any',
};

/**
 * `filetype`, from `<mach-o/loader.h>`.
 *
 * Transcribed from the installed SDK, and *fourteen* values rather than the twelve
 * this project's README used to claim. The two it was missing are `MH_GPU_EXECUTE`
 * and `MH_GPU_DYLIB` at 13 and 14, which is the interesting failure: they are the
 * *last* two, so a reader that covered 1..12 looked complete. A count in prose is a
 * claim about a table, and it drifts the moment the table is not read from the header.
 */
export const MH_TYPES = {
  0x1: 'MH_OBJECT',
  0x2: 'MH_EXECUTE',
  0x3: 'MH_FVMLIB',
  0x4: 'MH_CORE',
  0x5: 'MH_PRELOAD',
  0x6: 'MH_DYLIB',
  0x7: 'MH_DYLINKER',
  0x8: 'MH_BUNDLE',
  0x9: 'MH_DYLIB_STUB',
  0xa: 'MH_DSYM',
  0xb: 'MH_KEXT_BUNDLE',
  0xc: 'MH_FILESET',
  0xd: 'MH_GPU_EXECUTE',
  0xe: 'MH_GPU_DYLIB',
};

/**
 * Name a `filetype`, or report it as an unnamed number.
 *
 * An unrecognised value comes back `null` rather than a guess, because the
 * difference between "an executable" and "a file whose second word is 2" is the
 * difference between an answer and an invention.
 */
export function decodeFiletype(raw) {
  const named = MH_TYPES[raw];
  return { raw, name: named ?? null, named: named !== undefined };
}

/**
 * A stable string for a filetype, whichever form it arrives in.
 *
 * Exists because two call sites interpolate a filetype into a comparison, and both
 * got it wrong the same way when `parseThin` started returning the decoded object
 * instead of a number:
 *
 *   - {@link sliceShape} template-interpolated it, producing
 *     `filetype:[object Object]` — so every executable and every dylib hashed to the
 *     same value and the digest could no longer tell them apart, with no test failing
 *     because a digest that collapses two values into one still returns a digest;
 *   - the `diff` path compared with `!==`, and two freshly-decoded objects are never
 *     `===`, so **every** pair of binaries reported `filetype-changed`.
 *
 * One helper, two callers, because the second bug was the first bug copied. The name
 * is preferred and the raw word is the fallback, so an unrecognised filetype still
 * contributes its number rather than collapsing to the same value as every other
 * unrecognised one.
 *
 * @param {number | {raw: number, name: string | null}} ft
 * @returns {string}
 */
export function filetypeKey(ft) {
  if (ft === null || ft === undefined) return 'unknown';
  if (typeof ft === 'object') return ft.name ?? String(ft.raw);
  return String(ft);
}

/**
 * Name a `platform` word, or report it as an unnamed number.
 *
 * `PLATFORM_ANY` is the one entry that is named but not a platform: it is what a
 * *client* records when it will accept anything, and a binary carrying it was built
 * for something in particular. So it comes back `named: false` with the name
 * attached, and a caller counting "which platform is this for" does not count it.
 */
export function decodePlatform(raw) {
  const known = PLATFORMS[raw];
  if (!known) return { name: null, named: false };
  return { name: known, named: raw !== 0xffffffff && raw !== 0 };
}

/**
 * A packed `X.Y.Z` version, the form `minos` and `sdk` take.
 *
 * Three fields of unequal width — 16, 8 and 8 bits — and the top one is the one that
 * identifies a major release. Reading it as three equal bytes is the obvious mistake
 * and it is silent: `0x000E0000` is 14.0.0, and the three-equal-bytes reading of it
 * produces components that all look like plausible versions.
 *
 * The raw word is kept alongside the components, for the same reason
 * {@link decodeSourceVersion} keeps its own: the packed form is what the file holds
 * and what other readers report, so a value compared against another reader matches
 * without either side converting.
 *
 * @param {number} v the packed `uint32` version
 * @returns {{raw: number, x: number, y: number, z: number, text: string}}
 */
export function decodePackedVersion(v) {
  const x = (v >>> 16) & 0xffff;
  const y = (v >>> 8) & 0xff;
  const z = v & 0xff;
  return { raw: v, x, y, z, text: `${x}.${y}.${z}` };
}

/**
 * Mach-O and fat-header magics, as raw byte sequences.
 *
 * Compared as bytes rather than as integers, and that is not fussiness. A thin
 * little-endian Mach-O begins `cf fa ed fe`; read as a big-endian integer that
 * is 0xcffaedfe, which is in neither the fat nor the 64-bit-thin list, so a
 * reader written the obvious way accepts every universal binary and silently
 * rejects every thin one. Two copies of that check existed in this project at
 * one point and the test suite carried the correct version while the library
 * carried the broken one — so the check now lives here, once, and everything
 * imports it.
 */
export const MACHO_MAGICS = [
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // fat
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]), // fat, byte-swapped
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // 64-bit thin
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // 32-bit thin
];

/** True when `p` is a readable file whose first four bytes are a Mach-O magic. */
export function isMachOFile(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) return false;
    return MACHO_MAGICS.some((m) => head.equals(m));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A human name for a CPU type, falling back to its raw value.
 *
 * The fallback is a real fallback and not a placeholder: `sliceName` is the
 * only place an architecture is turned into text, so an unmapped cputype still
 * *reports* correctly — as `cputype=0x12` — where a name guessed from the magic
 * would report something false.
 *
 * Coverage is ordered by who actually hands us these files, not by whether the
 * Darwin headers list them. `ppc` is here because GameCube and Wii binaries
 * are Mach-O and a large, expert user base analyses them weekly; `ppc64` is one
 * more line for the same ecosystem. `arm64_32` is here because watchOS ships it,
 * and it is emphatically *not* a subtype of arm64 — see {@link archMatches}.
 */
export function sliceName(cputype) {
  if (cputype === CPU_X86_64) return 'x86_64';
  if (cputype === CPU_ARM64) return 'arm64';
  if (cputype === CPU_ARM64_32) return 'arm64_32';
  if (cputype === CPU_POWERPC64) return 'ppc64';
  if (cputype === CPU_POWERPC) return 'ppc';
  if (cputype === 0x0000000c) return 'arm';
  if (cputype === 0x00000007) return 'i386';
  if (cputype == null) return 'thin';
  return `cputype=0x${cputype.toString(16)}`;
}

/**
 * The subtypes that distinguish an architecture without changing its cputype.
 *
 * `arm64e` is not a separate `cputype` — it is `CPU_TYPE_ARM64` with a
 * different *subtype* — so {@link sliceName} cannot see it, and every arm64e
 * slice was reported as plain `arm64`. On iOS that is the difference between a
 * binary that uses pointer authentication and one that does not, which is the
 * first question anything PAC-related asks.
 *
 * Masked before comparison because the high byte carries capability flags
 * rather than subtype: `CPU_SUBTYPE_LIB64` is `0x80000000` and
 * `CPU_SUBTYPE_PTRAUTH_ABI` reuses the same bit, so a raw compare works on the
 * binaries seen so far and fails on one that set a flag — the kind of bug that
 * only appears on someone else's machine.
 */
export const CPU_SUBTYPE_ARM64E = 2;
/** `CPU_SUBTYPE_ARM64E | 8`, the arm64e variant advertising the v8 ISA. */
export const CPU_SUBTYPE_ARM64E_V8 = 10;

/**
 * A slice's architecture name, including the arm64e distinction.
 *
 * Takes the subtype and degrades to {@link sliceName} when it is absent, which
 * is a real case rather than a hypothetical: a thin slice's subtype may not have
 * been read, and `arm64` is a better answer than a fabricated `arm64e`. Every
 * call site therefore passes whatever it has, and an unknown subtype falls back
 * to the plain name rather than guessing.
 */
export function sliceArchName(cputype, cpusubtype) {
  if (cputype === CPU_ARM64) {
    const st = cpusubtype == null ? null : cpusubtype & 0x00ffffff;
    if (st === CPU_SUBTYPE_ARM64E || st === CPU_SUBTYPE_ARM64E_V8) return 'arm64e';
  }
  return sliceName(cputype);
}

/**
 * Open a file and return a bounded reader with a small read cache.
 *
 * The cache matters: walking load commands and the symbol table re-reads the
 * same few pages many times, and without it a 476 MB universal binary turns
 * into hundreds of thousands of syscalls.
 */
export function opener(p) {
  const fd = openSync(p, 'r');
  const size = fstatSync(fd).size;
  const cache = new Map();
  return {
    fd,
    size,
    path: p,
    /** Read `len` bytes at `off`. Short reads are returned as-is, never padded. */
    read(off, len) {
      if (off < 0 || len <= 0) return Buffer.alloc(0);
      if (off >= size) return Buffer.alloc(0);
      const want = Math.min(len, size - off);
      const key = `${off}:${want}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const b = Buffer.alloc(want);
      const n = readSync(fd, b, 0, want, off);
      const out = b.subarray(0, n);
      // Bounded rather than unbounded: the pointer-hunting tools sweep the
      // whole file and would otherwise pin hundreds of MB.
      if (cache.size > 4096) cache.clear();
      cache.set(key, out);
      return out;
    },
    close() {
      closeSync(fd);
    },
  };
}

/**
 * Parse a fat header into its slices, or null when this is not a fat binary.
 *
 * Returns `[]` rather than null for a fat file with no readable slice table,
 * so callers can tell "not fat" from "fat but unreadable".
 */
export function parseFat(f) {
  const head = f.read(0, 8);
  if (head.length < 8) return null;
  const magic = head.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_CIGAM) return null;
  const n = head.readUInt32BE(4);
  const slices = [];
  for (let i = 0; i < n; i++) {
    const o = f.read(8 + i * 20, 20);
    if (o.length < 20) break;
    slices.push({
      cputype: o.readUInt32BE(0),
      // Byte 4 of the 20-byte `fat_arch`. Skipped until arm64e needed it, which
      // is the shape of most gaps here: the subtype is only meaningful for a few
      // architectures, but a reader that does not carry it cannot name them at
      // all, and naming is what `--arch` matches on.
      cpusubtype: o.readUInt32BE(4),
      offset: o.readUInt32BE(8),
      size: o.readUInt32BE(12),
    });
  }
  return slices;
}

/**
 * Parse the load commands of the thin Mach-O at `base`.
 *
 * Returns null when there is no Mach-O header there, which is the normal
 * result for a non-binary file and must not throw.
 */
export function parseThin(f, base = 0) {
  const hdr = f.read(base, 32);
  if (hdr.length < 28) return null;
  const magic = hdr.readUInt32LE(0);
  const is64 = magic === MH_MAGIC_64;
  if (!is64 && magic !== MH_MAGIC_32) return null;

  const cputype = hdr.readUInt32LE(4);
  const cpusubtype = hdr.readUInt32LE(8);
  const filetype = hdr.readUInt32LE(12);
  const ncmds = hdr.readUInt32LE(16);
  const sizeofcmds = hdr.readUInt32LE(20);
  // Byte 24 in both header forms. `mach_header` and `mach_header_64` agree here
  // because the field precedes `reserved` and the only difference between the two
  // is that trailing 4 bytes plus the wider `n_value`s further in — so this one
  // is *not* a place the 32-bit/64-bit offset trap applies, and it is read
  // before `is64` is ever consulted rather than inside a `wide ?` ternary.
  const flags = hdr.readUInt32LE(24);
  let off = base + (is64 ? 32 : 28);
  const segments = [];
  const sections = [];
  const loadCommands = [];
  let symtab = null;
  let uuid = null;
  let functionStarts = null;
  let entryPoint = null;
  let sourceVersion = null;
  let buildVersion = null;
  let encryption = null;
  const rpaths = [];
  const dylibs = [];
  let installName = null;

  for (let i = 0; i < ncmds; i++) {
    const lc = f.read(off, 8);
    if (lc.length < 8) break;
    const cmd = lc.readUInt32LE(0);
    const cmdsize = lc.readUInt32LE(4);
    if (cmdsize < 8) break; // a zero cmdsize would loop forever

    // Recorded before any decoding, so every command appears even when nothing
    // here knows what it means. A reader that silently dropped the ones it did
    // not recognise would make an unfamiliar binary look simpler than it is,
    // which is the shape of a wrong answer rather than a partial one.
    loadCommands.push({ cmd, name: loadCommandName(cmd), cmdsize, offset: off - base });

    if (cmd === LC_UUID_CMD) {
      // 16 bytes at offset 8. A UUID is a value rather than an interpretation,
      // which is why it is read here and `LC_CODE_SIGNATURE` is not: reading the
      // bytes of an identifier is the same class of act as reading a section's
      // size, whereas following a code signature is decoding a structure. The
      // two differ by whether answering correctly requires understanding
      // something else's format.
      const s = f.read(off, 24);
      if (s.length >= 24) {
        uuid = s.toString('hex', 8, 24).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      }
    } else if (cmd === LC_SYMTAB) {
      const s = f.read(off, 24);
      if (s.length >= 24) {
        symtab = {
          symoff: s.readUInt32LE(8),
          nsyms: s.readUInt32LE(12),
          stroff: s.readUInt32LE(16),
          strsize: s.readUInt32LE(20),
        };
      }
    } else if (cmd === LC_FUNCTION_STARTS_CMD) {
      // `struct linkedit_data_command`: two `uint32_t`s after the header.
      // `dataoff` is a file offset into `__LINKEDIT` — relative to the slice, the
      // same basis every other offset in a load command uses — and `datasize` is
      // how many bytes the blob occupies, terminator and any padding included.
      // The bytes are decoded lazily by `functionStartAddresses`, because a slice
      // that is never asked about function starts should not pay to read them.
      const s = f.read(off, 16);
      if (s.length >= 16) {
        functionStarts = { dataoff: s.readUInt32LE(8), datasize: s.readUInt32LE(12), cmdsize };
      }
    } else if (cmd === LC_MAIN_CMD || cmd === LC_MAIN) {
      // `struct entry_point_command`: `cmdsize` 24, with `entryoff` and
      // `stacksize` both `uint64_t`. That is the form a real binary emits, and it
      // is matched on the `LC_REQ_DYLD` value (`0x80000028`) because that — not a
      // bare `0x28` — is how `<mach-o/loader.h>` defines `LC_MAIN`.
      //
      // This reader previously matched the bare `0x29` and concluded that every
      // binary shipped a 16-byte command. `0x29` is `LC_DATA_IN_CODE`, a
      // `linkedit_data_command` carrying `dataoff`/`datasize`; its `dataoff` is a
      // file offset into `__LINKEDIT`, which is why `describe` used to report an
      // entry offset that landed outside `__TEXT`. The `cmdsize` bound below is
      // kept as defence against a malformed file, not because a shorter form is
      // expected. `entryoff` stays a BigInt: narrowing a genuine 64-bit offset to
      // a Number would lose precision above 2^53.
      const want = Math.min(cmdsize, 24);
      const s = f.read(off, want);
      if (s.length >= 16) {
        const raw = s.readBigUInt64LE(8);
        const wide = cmdsize >= 24;
        entryPoint = {
          entryoff: wide ? raw : (raw & 0xffffffffn),
          rawHigh32: Number((raw >> 32n) & 0xffffffffn),
          // `null`, not 0, when the command is too short to carry it: "this
          // command declared no stack size" and "this command declared a stack
          // size of zero" are different claims, and only one is true.
          stacksize: wide ? s.readBigUInt64LE(16) : null,
          cmdsize,
          valueBasis: wide
            ? 'LC_MAIN.entryoff read as uint64 — the documented 24-byte layout'
            : `LC_MAIN.entryoff read as its low 32 bits — this command declares cmdsize ${cmdsize}, ` +
              'shorter than the documented 24 bytes',
        };
      }
    } else if (cmd === LC_RPATH_CMD) {
      // `struct rpath_command` ends in `union lc_str path`, which is an *offset*
      // — measured from the start of this load command — not a string stored
      // inline. Reading eight bytes in as if it were the first characters of the
      // path yields a string that looks like a path: a little-endian length-like
      // value, and it will pass a "does it look sane" check while naming a
      // directory that does not exist. The offset is taken literally, and
      // bounds-checked against this command's own `cmdsize`.
      const s = f.read(off, 12);
      if (s.length >= 12) {
        const rel = s.readUInt32LE(8);
        if (rel >= 12 && rel < cmdsize) {
          const body = f.read(off + rel, cmdsize - rel);
          const z = body.indexOf(0);
          const path = body.toString('latin1', 0, z < 0 ? body.length : z);
          if (path) rpaths.push(path);
        }
      }
    } else if (DYLIB_COMMANDS.has(cmd) || cmd === DYLIB_ID_CMD) {
      // `struct dylib_command`, the one load command that says *what this binary
      // needs to run* — the answer to the most-asked question about any
      // executable, and the one `otool -L` exists to print.
      //
      // The `dylib` field is a `union lc_str`, so it is an offset from the start
      // of this command for the same reason `LC_RPATH`'s is: reading the eight
      // bytes in as if they were the first characters of the name yields a string
      // that looks like a path and passes a plausibility check while naming a
      // library that does not exist. The offset is taken literally.
      //
      // `cmdsize >= 24` is the floor rather than a nicety: below it the version
      // fields are not present, and reading them would take bytes from the
      // *next* load command. A truncated command is reported by `audit`; here it
      // yields no name rather than a fabricated one.
      const s = f.read(off, 24);
      if (s.length >= 24 && cmdsize >= 24) {
        const rel = s.readUInt32LE(8);
        if (rel >= 24 && rel < cmdsize) {
          const body = f.read(off + rel, cmdsize - rel);
          const z = body.indexOf(0);
          const name = body.toString('latin1', 0, z < 0 ? body.length : z);
          if (name) {
            const decoded = {
              name,
              cmd,
              cmdName: loadCommandName(cmd),
              timestamp: s.readUInt32LE(12),
              currentVersion: s.readUInt32LE(16),
              compatVersion: s.readUInt32LE(20),
            };
            if (cmd === DYLIB_ID_CMD) installName = decoded;
            else dylibs.push({ ...decoded, linkage: DYLIB_COMMANDS.get(cmd).linkage });
          }
        }
      }
    } else if (cmd === LC_ENCRYPTION_INFO_CMD || cmd === LC_ENCRYPTION_INFO_64_CMD) {
      // `struct encryption_info_command`, 20 bytes, identical in both forms —
      // `LC_ENCRYPTION_INFO_64` differs only in that the encrypted range it names is
      // a 64-bit one, which is already true because the offsets are 32-bit words into
      // a 64-bit file's address space. `cryptid` is the one field that matters:
      //
      //   0  the binary is not encrypted, or has been decrypted in place
      //   1  __TEXT is ciphertext — an App Store build, not yet run once
      //   >1  encrypted with a key whose sub-version this is (FairPlay)
      //
      // This is the single fact that decides whether a zero result from `findcall`,
      // `findliteral` or `--strings` means "not present" or "not readable", and
      // reporting it is the difference between those two being distinguishable. A
      // command naming encryption is *not* enough — a decrypted binary keeps the
      // command with `cryptid` 0, and reading presence rather than value would call
      // a decrypted App Store binary still encrypted.
      const s = f.read(off, 20);
      if (s.length >= 20) {
        encryption = {
          command: loadCommandName(cmd),
          cryptoff: s.readUInt32LE(8),
          cryptsize: s.readUInt32LE(12),
          cryptid: s.readUInt32LE(16),
          /** True only for a positive `cryptid` — see above. */
          encrypted: s.readUInt32LE(16) > 0,
        };
      }
    } else if (cmd === LC_BUILD_VERSION_CMD) {
      // `struct build_version_command`: `cmdsize` 24 for a binary with no tool
      // records, then 8 bytes per tool. The three fields that matter are read and the
      // tool records are not — they are a list of `{tool, version}` pairs whose tools
      // are identified by the SDK's own enum, which is a second table to transcribe
      // and a second thing to get subtly wrong. So the command is decoded for the
      // platform it names and the tools are left alone rather than reported wrongly.
      const s = f.read(off, 24);
      if (s.length >= 24) {
        const raw = s.readUInt32LE(8);
        buildVersion = {
          command: 'LC_BUILD_VERSION',
          platform: decodePlatform(raw).name,
          platformRaw: raw,
          minos: decodePackedVersion(s.readUInt32LE(12)),
          sdk: decodePackedVersion(s.readUInt32LE(16)),
          // Reported rather than acted on: a reader that stops at 24 bytes on a
          // command with `ntools > 0` would silently ignore the rest of it, and a
          // caller deserves to know that is what happened.
          ntools: s.readUInt32LE(20),
        };
      }
    } else if (VERSION_MIN_COMMANDS.has(cmd)) {
      // `struct version_min_command`, `cmdsize` 16: a packed version and the SDK
      // that built it, with the platform implied by the command. This is the form
      // `LC_BUILD_VERSION` replaced, and it is why `describe` reports `platform`
      // from either.
      const s = f.read(off, 16);
      if (s.length >= 16) {
        const platform = VERSION_MIN_COMMANDS.get(cmd);
        buildVersion = {
          command: loadCommandName(cmd),
          platform,
          platformRaw: null,
          minos: decodePackedVersion(s.readUInt32LE(8)),
          sdk: decodePackedVersion(s.readUInt32LE(12)),
          ntools: 0,
        };
      }
    } else if (cmd === LC_SOURCE_VERSION_CMD) {
      // `struct source_version_command`, `cmdsize` 16. The packing is
      // `a24.b10.c10.d10.e10`; see {@link decodeSourceVersion}.
      const s = f.read(off, 16);
      if (s.length >= 16) sourceVersion = decodeSourceVersion(s.readBigUInt64LE(8));
    } else if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
      const wide = cmd === LC_SEGMENT_64;
      const need = wide ? 72 : 56;
      const s = f.read(off, need);
      if (s.length >= need) {
        const segname = s.toString('latin1', 8, 24).replace(/\0.*$/, '');
        segments.push({
          segname,
          vmaddr: wide ? s.readBigUInt64LE(24) : BigInt(s.readUInt32LE(24)),
          vmsize: wide ? s.readBigUInt64LE(32) : BigInt(s.readUInt32LE(28)),
          fileoff: wide ? s.readBigUInt64LE(40) : BigInt(s.readUInt32LE(32)),
          filesize: wide ? s.readBigUInt64LE(48) : BigInt(s.readUInt32LE(36)),
          // The two protection masks and the segment flags, read from the same
          // transcribed offsets as the sizes above rather than by scaling: `maxprot`
          // sits at 56 in `segment_command_64` and 40 in `segment_command`, which is
          // the same 16-byte gap the address fields open and not a multiple of it.
          //
          // These answer "may the loader write here, and did the linker say this
          // segment must be zero-filled and protected until used" — which is what
          // distinguishes `__PAGEZERO` (maxprot 0, entirely unwritable) from a
          // segment that merely happens to be mapped read-only. A reader that
          // reports only vmaddr and vmsize cannot tell those apart, and would call
          // `__PAGEZERO` a 4 GiB writable mapping.
          maxprot: s.readUInt32LE(wide ? 56 : 40),
          initprot: s.readUInt32LE(wide ? 60 : 44),
          flags: s.readUInt32LE(wide ? 68 : 52),
        });
        // Section entries follow the segment command. Both forms carry them —
        // this used to read only the 64-bit one, which meant a 32-bit slice
        // reported zero sections and every address lookup in it came back "not
        // in a section".
        //
        // The offsets below are transcribed from `<mach-o/loader.h>` in the macOS
        // SDK rather than derived from the 64-bit form, because the two layouts
        // are not related by a scale factor:
        //
        //   field       section_64   section
        //   addr            32          32
        //   size            40          36
        //   offset          48          40
        //   flags           64          56
        //   entry size      80          68
        //
        // `addr` is the only field at the same offset in both, because the two
        // 16-byte name fields above it are the same size in both. Every 32-bit
        // field after it shifts the next one 4 bytes earlier, so `flags` ends up
        // 8 bytes apart and the entries differ in length by 12 rather than by a
        // factor. Scaling 48 by 68/80 happens to give 40 — the right answer by
        // luck, and the wrong way to arrive at one.
        const sectsAt = wide ? 64 : 48;          // nsects, in the segment command
        const sectSize = wide ? 80 : 68;
        const sectBase = off + (wide ? 72 : 56);  // the segment command's own size
        const nsects = s.readUInt32LE(sectsAt);
        for (let k = 0; k < nsects; k++) {
          const sc = f.read(sectBase + k * sectSize, sectSize);
          if (sc.length < sectSize) break;
          const secFlags = sc.readUInt32LE(wide ? 64 : 56);
          sections.push({
            sectname: sc.toString('latin1', 0, 16).replace(/\0.*$/, ''),
            segname: sc.toString('latin1', 16, 32).replace(/\0.*$/, ''),
            addr: wide ? sc.readBigUInt64LE(32) : BigInt(sc.readUInt32LE(32)),
            size: Number(wide ? sc.readBigUInt64LE(40) : sc.readUInt32LE(36)),
            offset: sc.readUInt32LE(wide ? 48 : 40),
            // `align`, `reloff` and `nreloc`, from the same two transcribed layouts.
            // These are the three fields that describe *how* the section is laid out
            // rather than where it is, and they are what a reader needs to rebuild a
            // section's byte range by hand:
            //
            //   field       section_64   section
            //   align           52          44
            //   reloff          56          48
            //   nreloc          60          52
            //
            // `align` is a power of *two*, not a byte count — `2` means 4-byte
            // alignment, `0` means "no alignment constraint recorded". It is reported
            // raw rather than expanded, because the raw form is what the file holds
            // and what every other reader reports, so a value cross-checked against
            // one of them compares equal without a conversion on either side.
            align: sc.readUInt32LE(wide ? 52 : 44),
            reloff: sc.readUInt32LE(wide ? 56 : 48),
            nreloc: sc.readUInt32LE(wide ? 60 : 52),
            // Section attributes. Read because S_ATTR_*_INSTRUCTIONS is the only
            // in-file signal that separates code from data, and a byte scanner
            // that cannot tell them apart reports data as call sites — see
            // `instructionSections`. Offset 64 in `section_64`, 56 in `section`.
            //
            // `flags` stays the raw word and stays authoritative; the decoded
            // `type`/`attributes` are spread in beside it rather than replacing
            // it, so a caller that needs the undecoded value — and the abnormality
            // check does, to notice attribute bits this table cannot name — does
            // not have to recompute it.
            flags: secFlags,
            ...decodeSectionFlags(secFlags),
          });
        }
      }
    }
    off += cmdsize;
  }
  return {
    is64, cputype, cpusubtype, filetype: decodeFiletype(filetype), ncmds, sizeofcmds, flags,
    segments, sections, loadCommands, symtab, uuid,
    entryPoint, sourceVersion, buildVersion, encryption, rpaths, dylibs, installName,
    functionStarts,
  };
}

/**
 * Every slice of a binary, as `{ cputype, offset, size, thin }`.
 *
 * A thin binary comes back as a single slice with `thin: true` and a null
 * cputype, so callers can treat both shapes identically.
 */
export function slicesOf(f) {
  const fat = parseFat(f);
  if (fat) return fat.map((s) => ({ ...s, thin: false }));
  return [{ cputype: null, cpusubtype: null, offset: 0, size: f.size, thin: true }];
}

/** The `__TEXT` section of a parsed slice, which is where literals live. */
export function textSection(thin) {
  return (
    thin.sections.find((s) => s.segname === '__TEXT' && s.size > 0) ||
    thin.sections.find((s) => s.segname === '__TEXT') ||
    null
  );
}

/** True when a section's attributes say it contains instructions. */
export function isCodeSection(sec) {
  return (sec.flags & (S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS)) !== 0;
}

/**
 * The sections of a slice that hold code, ordered as they appear in the file.
 *
 * This is what turns an untyped byte scan into a typed one. The previous
 * approach scanned `__text` end to end, and `__text` is not entirely code: it
 * also carries the `__cstring`/`__const`/`__literal*` sections, jump tables and
 * alignment padding. Any of those can contain bytes that decode as a `call
 * rel32` pointing at the address you asked about, and each such byte was
 * reported as a call site. The output looked like a list of callers and was
 * partly fiction.
 *
 * `__stubs` is included deliberately: PLT stubs are code and do contain direct
 * `jmp rel32` and `call rel32` instructions, so they are legitimate results and
 * filtering them out would hide real edges.
 *
 * Falls back to every non-empty section when the slice carries no
 * instruction-flagged section at all. That is a rare and slightly worrying
 * input — a hand-built or unusual binary — and the alternative (report zero
 * call sites) would be the confident-wrong-answer failure this project has
 * already produced several of. `fallback: true` in the result tells the caller
 * which answer it got.
 */
export function codeSections(thin) {
  const code = thin.sections.filter((s) => s.size > 0 && isCodeSection(s));
  if (code.length) return { sections: code, fallback: false };
  return {
    sections: thin.sections.filter((s) => s.size > 0),
    fallback: true,
  };
}

/**
 * Read every symbol name in a slice.
 *
 * Both defined symbols (N_SECT) and imported ones are kept and counted apart:
 * a family satisfied only by an import is weaker evidence than one satisfied
 * by the engine's own definition, so `entries` exposes the distinction rather
 * than flattening it. Debugging entries (N_STAB) are skipped — they are not
 * symbols.
 *
 * `names` is the convenient form for substring matching. `entries` carries
 * each symbol's vaddr and defined/imported flag, which the address-oriented
 * tools (`sym`, `symlookup`) need and which a name-only
 * projection would throw away.
 */
export function readSymbols(f, base, thin) {
  const { symtab } = thin;
  // Every return path carries the same keys. The two early ones used to omit
  // `entries`, so a caller that destructured uniformly — which is what the test
  // suite did — got `undefined` and threw on a binary with no symbol table. That
  // is the worst shape for a reader whose whole job is to handle binaries that
  // lack things: the case where the fields are missing is exactly the case
  // nobody exercises until they hit it in the wild.
  if (!symtab || symtab.nsyms === 0) {
    return {
      names: [], entries: [], defined: 0,
      total: symtab ? symtab.nsyms : 0,
      note: symtab ? 'empty symbol table' : 'no LC_SYMTAB',
    };
  }

  const str = f.read(base + symtab.stroff, symtab.strsize);
  if (str.length === 0) {
    return { names: [], entries: [], defined: 0, total: symtab.nsyms, note: 'empty string table' };
  }

  const nameAt = (x) => {
    if (x >= str.length) return '';
    const z = str.indexOf(0, x);
    return str.toString('latin1', x, z < 0 ? str.length : z);
  };

  const names = [];
  const entries = [];
  let defined = 0;
  const BATCH = 20000;
  // `nlist` is 16 bytes in the 64-bit form and 12 in the 32-bit one, and its
  // `n_value` is a `uint64_t` in the first and a `uint32_t` in the second. This
  // used to read 16-byte entries with a 64-bit value unconditionally, so every
  // symbol in a 32-bit slice was read at the wrong stride: names came from the
  // wrong place in the string table, `n_type` from what was actually another
  // entry's `n_strx`, and the address from bytes that were never an address. The
  // symptom was not an error — it was plausible-looking wrong symbols, which is
  // why the stride is taken from the parse rather than written as a constant.
  const nlistSize = thin.is64 ? 16 : 12;
  for (let b = 0; b < symtab.nsyms; b += BATCH) {
    const cnt = Math.min(BATCH, symtab.nsyms - b);
    const blk = f.read(base + symtab.symoff + b * nlistSize, cnt * nlistSize);
    if (blk.length < cnt * nlistSize) break;
    for (let i = 0; i < cnt; i++) {
      const at = i * nlistSize;
      const info = blk[at + 4];
      if (info & N_STAB) continue;
      const strx = blk.readUInt32LE(at);
      if (strx >= str.length) continue;
      const isDefined = (info & N_TYPE) === N_SECT;
      if (isDefined) defined++;
      const nm = nameAt(strx);
      if (!nm) continue;
      names.push(nm);
      entries.push({
        name: nm,
        addr: thin.is64 ? blk.readBigUInt64LE(at + 8) : BigInt(blk.readUInt32LE(at + 8)),
        defined: isDefined,
      });
    }
  }
  return { names, entries, defined, total: symtab.nsyms, note: null };
}

/**
 * The function start addresses of a slice, decoded from `LC_FUNCTION_STARTS`.
 *
 * ## The format
 *
 * `LC_FUNCTION_STARTS` names a blob in `__LINKEDIT`: a sequence of ULEB128
 * values. The first is a delta from the image base — the `__TEXT` segment's
 * `vmaddr`, which is also the address of the Mach header — and every later one is
 * a delta from the address before it. A zero value ends the list; anything after
 * it is alignment padding.
 *
 * ## Why the base is `__TEXT.vmaddr` and not zero
 *
 * Every measured binary puts its first function a little after `__TEXT.vmaddr`,
 * and the deltas are small. Treating them as absolute would report that function
 * at `0x1f8` rather than `0x1000001f8` — an address plausible enough to be passed
 * to another tool and looked up, which is why the base is read rather than
 * assumed. This is the same reasoning that keeps `entryoff` a raw offset: a
 * derived address that is wrong is worse than an offset that is honest.
 *
 * ## Truncation is reported, not hidden
 *
 * A blob whose last value still has its continuation bit set is damaged or
 * clipped. The partial value is dropped and `truncated` is true, because a
 * silently dropped value turns "the list ends here" into a complete-looking list
 * that is one short.
 *
 * @param {Opener} f
 * @param {Thin} thin
 * @param {number} [sliceOffset=0] the slice's position in the file
 */
export function functionStartAddresses(f, thin, sliceOffset = 0) {
  const fs = thin.functionStarts;
  if (!fs || fs.datasize === 0) {
    return { base: null, addresses: [], truncated: false, present: false };
  }
  const text = thin.segments.find((s) => s.segname === '__TEXT');
  const base = text ? text.vmaddr : thin.segments[0]?.vmaddr ?? 0n;
  const buf = f.read(sliceOffset + fs.dataoff, fs.datasize);
  const addresses = [];
  let addr = base;
  let i = 0;
  let truncated = false;
  while (i < buf.length) {
    let value = 0n;
    let shift = 0n;
    let more = true;
    while (more) {
      if (i >= buf.length) {
        truncated = true;
        break;
      }
      const byte = buf[i++];
      value |= BigInt(byte & 0x7f) << shift;
      more = (byte & 0x80) !== 0;
      shift += 7n;
    }
    if (truncated) break;
    if (value === 0n) break; // the terminator
    addr += value;
    addresses.push(addr);
  }
  return { base, addresses, truncated, present: true };
}

/**
 * Pick the slice most worth probing: the one with the most symbols.
 *
 * A universal binary can be stripped on one architecture and not the other, so
 * "first slice" is the wrong rule. Falls back to the first parseable slice so
 * a fully stripped binary still gets its string scan run.
 */
export function richestSlice(f) {
  let best = null;
  for (const s of slicesOf(f)) {
    const thin = parseThin(f, s.offset);
    if (!thin) continue;
    const syms = readSymbols(f, s.offset, thin);
    const entry = {
      ...s,
      arch: s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype),
      thin,
      names: syms.names,
      nsyms: syms.total,
      ndefined: syms.defined,
      stripped: syms.note || syms.total === 0,
      symNote: syms.note,
    };
    if (!best || entry.names.length > best.names.length) best = entry;
  }
  return best;
}

/**
 * The byte offset of the slice a tool should read.
 *
 * This is the one number the old tools got wrong by hardcoding. It reads only
 * the load commands and the symbol *count*, not the symbol names, so it is
 * cheap enough to call before deciding what else to do — the address-oriented
 * tools need the offset and then walk the symtab themselves.
 *
 * @param {object} f        an `opener()` handle
 * @param {string} [prefer] architecture to prefer, e.g. 'x86_64'
 * @returns {{offset:number, arch:string, nsyms:number, thin:object}|null}
 *
 * `prefer` is a preference, not a requirement. The first version treated it as
 * a requirement and returned null whenever the named slice was absent, which
 * made every caller fail outright on an arm64-only binary — including on a
 * thin arm64 Go toolchain, where there is no x86_64 slice to find. The right
 * behaviour is "use this one if it exists, otherwise take the richest", and
 * reporting which slice was actually chosen is the caller's job.
 */
export function preferredSlice(f, prefer) {
  let best = null;
  for (const s of slicesOf(f)) {
    const thin = parseThin(f, s.offset);
    if (!thin) continue;
    const arch = s.thin ? sliceArchName(thin.cputype, thin.cpusubtype) : sliceArchName(s.cputype, s.cpusubtype);
    const nsyms = thin.symtab ? thin.symtab.nsyms : 0;
    const entry = { offset: s.offset, arch, nsyms, thin, size: s.size };
    // `archMatches`, not `===`. Naming arm64e as its own architecture turned this
    // comparison into a real bug: on an Apple-silicon system binary whose slice
    // is `arm64e`, `--arch=arm64` stopped matching, the preference was ignored,
    // and the caller got whichever slice happened to be richest — silently the
    // wrong answer to a question that had been asked precisely.
    if (prefer && archMatches(arch, prefer)) return entry;
    if (!best || nsyms > best.nsyms) best = entry;
  }
  return best;
}

/**
 * True when a slice's architecture name satisfies a requested one.
 *
 * The comparison is by name because that is what `--arch` takes, and names are
 * what every tool already reports. A caller asking for `arm64` against an
 * `arm64e` slice is asking for the same instruction set, so the `e` suffix is
 * ignored — otherwise `--arch=arm64` would read nothing from an Apple-silicon
 * system binary whose slice is named `arm64e`, and report the file as empty.
 *
 * The suffix rule is deliberately narrow, and the names added since say why it
 * has to stay that way. `arm64e` differs from `arm64` only in capability bits on
 * the same 64-bit instruction set, so collapsing them is safe. `arm64_32` and
 * `ppc`/`ppc64` are a different thing entirely: `arm64_32` is 32-bit pointers
 * under a distinct ABI, and the two PowerPC types differ in pointer width. None
 * of them ends in `e`, so none of them collapse, and that is the property worth
 * asserting rather than assuming — a name that later gained a trailing `e`
 * would silently start matching an architecture it is not.
 */
export function archMatches(sliceArch, want) {
  if (!want) return true;
  if (sliceArch === want) return true;
  return String(sliceArch).replace(/e$/, '') === String(want).replace(/e$/, '');
}

/**
 * True when a section occupies bytes in the file, as opposed to being zero-fill.
 *
 * `__bss` and `__noptrbss` have a real `addr` and a real `size` but no bytes
 * anywhere: the loader supplies zeros. The linker records their file `offset` as
 * 0, and their address range usually extends past the end of the segment's
 * `filesize`, so a `size > 0` test does not exclude them.
 *
 * This distinction decides whether an address can be read from the file at all,
 * and getting it wrong is not a small error. In `go`, `__DATA,__bss` covers
 * file offsets 0 through 180,760 — which are the Mach-O header and its load
 * commands. A `o2a` that treated it as backed by the file reported file offset
 * 0x1000 as being inside `__bss`, when it is the first byte of `__text`.
 *
 * The test is containment in the owning segment's file range rather than a
 * comparison against the section's own `offset`, because `offset` is the field
 * that is *not* meaningful for these sections.
 */
export function isBackedByFile(thin, sec) {
  if (sec.size === 0) return false;
  const seg = thin.segments.find((g) => g.segname === sec.segname);
  if (!seg) return sec.offset !== 0;
  // A section's file range is only real if it lies within the segment's.
  return sec.offset >= Number(seg.fileoff)
    && sec.offset + sec.size <= Number(seg.fileoff) + Number(seg.filesize);
}

/**
 * An `LC_MAIN` entry point, reported as the file offset the header declares.
 *
 * ## Why there is still no address here
 *
 * `<mach-o/loader.h>` calls `entryoff` the "file (__TEXT) offset of main()".
 * Now that `parseThin` matches the command that actually carries it
 * (`0x80000028`), that offset is a genuine file offset — the earlier note about it
 * "landing in `__LINKEDIT`" was an artefact of reading `LC_DATA_IN_CODE` instead.
 *
 * `vaddr` is nevertheless `null`, and deliberately: the value this function
 * returns is the *raw* field, and an address is one derivation away from it, via
 * `a2o`. Deriving it here would put a second, independently-computed answer for
 * the same fact next to `a2o`'s, and two answers that can disagree is the failure
 * mode this package exists to avoid. A caller that wants the address passes
 * `entryoff` to `a2o`; a caller that wants the symbol passes it to `symlookup`.
 *
 * `entryoffLandsInText` is reported because it is checkable and it is a useful
 * integrity signal — a valid entry offset lies inside `__TEXT` — without being an
 * abnormality, since a dyld shared-cache stub legitimately has no `__TEXT` bytes
 * of its own.
 *
 * @param {object} thin a `parseThin()` result
 * @returns {null|{entryoff: bigint, stacksize: bigint|null, cmdsize: number,
 *   vaddr: null, entryoffLandsInText: boolean|null, note: string}}
 */
export function resolveEntryPoint(thin) {
  if (!thin.entryPoint) return null;
  const { entryoff, stacksize, cmdsize, rawHigh32, valueBasis } = thin.entryPoint;
  const text = thin.segments.find((g) => g.segname === '__TEXT') || null;
  const inText = text
    ? entryoff >= text.fileoff && entryoff < text.fileoff + text.filesize
    : null;
  return {
    entryoff,
    stacksize,
    cmdsize,
    rawHigh32,
    valueBasis,
    vaddr: null,
    entryoffLandsInText: inText,
    note: 'raw file (__TEXT) offset; no address is derived from it — pass entryoff ' +
      'to a2o for the vaddr, or to symlookup for the symbol'
      + (inText === false ? ', and this one falls outside __TEXT' : ''),
  };
}

/**
 * Shannon entropy of a buffer, in bits per byte (0..8).
 *
 * Sampled over at most `maxBytes` rather than the whole buffer. The only consumer
 * is the packing heuristic in {@link detectAbnormalities}, and "is this blob
 * compressed" is answered by its first megabyte as reliably as by its last —
 * whereas a 200 MB string table read in full on every `describe` would make the
 * cheapest tool in the package the slowest one. Sampling a prefix also keeps the
 * measurement cheap for the fixture-sized files the suite runs on.
 */
/* ------------------------------------------------------------------ *
 * fingerprint
 * ------------------------------------------------------------------ */

/**
 * A short, stable digest of a list of strings, order-independent.
 *
 * Sorted before hashing, because the same program produces these lists in whatever
 * order the linker happened to emit them and a fingerprint that changed when the
 * linker changed its mind would be useless for the only question it is asked.
 *
 * A digest rather than the list itself, for two reasons: the lists run to tens of
 * thousands of entries, and the value is meant to be comparable at a glance and
 * quotable in a bug report.
 *
 * Separated by a byte that cannot occur in a symbol name, so `["ab","c"]` and
 * `["a","bc"]` cannot collide. Without the separator those two hash identically —
 * which is not a theoretical concern, since C++ mangled names are built from exactly
 * those pieces.
 */
export function digestOf(items, length = 12) {
  const h = createHash('sha256');
  for (const s of [...items].sort()) {
    h.update(s, 'latin1');
    h.update('\0');
  }
  return h.digest('hex').slice(0, length);
}

/**
 * Load commands excluded from a slice's shape digest, because they record *this
 * build's provenance* rather than what the program is.
 *
 * This list was not guessed. Comparing a fixture against a copy of itself with an
 * `LC_UUID` appended reported "different programs", which is absurd: `LC_UUID`
 * says which build produced a file, not what is in it, and the fingerprint already
 * reports the UUID separately and exactly. Leaving it in the shape made the digest
 * sensitive to precisely the kind of change the digest exists to ignore.
 *
 * Each entry, with the reason it earns its place:
 *
 *   LC_UUID              the build id. Already reported as `uuid`, exactly.
 *   LC_CODE_SIGNATURE    present only once the file has been signed, so a build
 *                        that skipped signing differs from one that did not while
 *                        containing identical code.
 *   LC_DYLIB_CODE_SIGN_DRS  the same, for the signature's own resource directory.
 *   LC_SOURCE_VERSION    the source revision, which moves with the VCS state rather
 *                        than with the program.
 *
 * Deliberately *not* excluded, because they are properties of the program rather
 * than of the build: the version-minimum and build-version commands (what the
 * binary requires), every dylib load (which library it needs), and everything else.
 * A digest that ignored those would call two genuinely different binaries the same,
 * which is the failure this whole feature is meant to avoid.
 */
const PROVENANCE_COMMANDS = new Set([
  'LC_UUID',
  'LC_CODE_SIGNATURE',
  'LC_DYLIB_CODE_SIGN_DRS',
  'LC_SOURCE_VERSION',
]);

/**
 * A structural digest of one slice: what it *is*, with nothing that a rebuild moves.
 *
 * ## What goes in, and what is deliberately left out
 *
 * In: the architecture, the word size, the filetype, every section's name, every
 * load command's *name* except the provenance ones, and every defined symbol's
 * name.
 *
 * Out: every address, every size, every offset, the UUID, and the version numbers
 * and paths inside `LC_LOAD_DYLIB`. All of those change between two builds of the
 * same source — ASLR and a PIE base move every address, a dependency bump moves a
 * dylib's current version, a rebuild moves a timestamp — so including any of them
 * would make the fingerprint answer "were these built by the same invocation",
 * which is a question the UUID already answers better.
 *
 * The one judgement call worth naming is section *sizes*, which are excluded for
 * the same reason: a rebuild that changes a dependency's version changes a size
 * without changing the program. That does make a stripped binary's fingerprint
 * weaker, which is why {@link sliceShape} reports a `tier` rather than presenting
 * a structure-only digest as though it were as strong as a full one.
 *
 * ## Pure, and deliberately so
 *
 * Takes its inputs rather than a file handle, so it is testable without a binary
 * and cannot be confused with a function that reads anything.
 *
 * @param {object} p
 * @param {string} p.arch      architecture name
 * @param {number} p.bits      64 or 32
 * @param {number} p.filetype  the `MH_*` value
 * @param {Array<{segname: string, sectname: string}>} p.sections
 * @param {Array<{name: string}>} p.loadCommands
 * @param {Array<{name: string}>} p.definedSymbols  names only
 * @returns {{structure: string, symbols: string|null, fingerprint: string, tier: 'full'|'structure-only', nsyms: number}}
 */
export function sliceShape({ arch, bits, filetype, sections, loadCommands, definedSymbols }) {
  // Interpolated straight into the digest, so it has to be a stable string — see
  // {@link filetypeKey} for what went wrong here and in `diff` when it was a number.
  const ftKey = filetypeKey(filetype);
  const structure = digestOf([
    `arch:${arch}`,
    `bits:${bits}`,
    `filetype:${ftKey}`,
    ...sections.map((s) => `sect:${s.segname},${s.sectname}`),
    // Names only. A dylib's path and version live inside the command and change on
    // every dependency bump; the fact that the binary loads a dylib does not.
    // Names only, and provenance excluded — see `PROVENANCE_COMMANDS`. A dylib's
    // path and version live inside the command and change on every dependency bump;
    // the fact that the binary loads a dylib does not.
    ...loadCommands.filter((c) => !PROVENANCE_COMMANDS.has(c.name)).map((c) => `lc:${c.name}`),
  ]);

  const nsyms = definedSymbols.length;
  if (nsyms === 0) {
    // No names to work with, so the digest is structural only — and says so. A
    // stripped binary is not a weaker *program*, but the fingerprint of one is a
    // weaker claim, and presenting the two identically would overstate it.
    return { structure, symbols: null, fingerprint: structure, tier: 'structure-only', nsyms: 0 };
  }
  const symbols = digestOf(definedSymbols.map((s) => `sym:${s.name}`));
  // Both digests are folded in, so the result changes if *either* the structure or
  // the symbol set does — including the case where a binary gains or loses symbols
  // without gaining or losing sections.
  const fingerprint = digestOf([`structure:${structure}`, `symbols:${symbols}`]);
  return { structure, symbols, fingerprint, tier: 'full', nsyms };
}

/**
 * A structural digest for a whole file, across every slice.
 *
 * Per-slice digests are combined rather than pooled, because a universal binary's
 * slices are independently meaningful: two builds of the same program that gained
 * an architecture should match on the slices they share and differ on the one that
 * is new. Pooling would report "different" for both and hide which.
 *
 * @param {Array<{arch: string, fingerprint: string}>} slices
 */
export function fileShape(slices) {
  return digestOf(slices.map((s) => `slice:${s.arch}:${s.fingerprint}`));
}

export function shannonEntropy(f, offset, length, maxBytes = 1 << 20) {
  const n = Math.min(length, maxBytes);
  if (n <= 0) return 0;
  const buf = f.read(offset, n);
  if (buf.length === 0) return 0;
  const freq = new Uint32Array(256);
  for (const b of buf) freq[b]++;
  let h = 0;
  for (const c of freq) {
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Above this many bits per byte, a string table is treated as probably packed. */
const PACKED_ENTROPY = 6.4;

/**
 * Structural problems in one slice, reported rather than thrown.
 *
 * ## Why this exists
 *
 * Every other function in this reader answers a question about a well-formed
 * binary. This one answers a question about a *malformed* one, which is the
 * case where the confident-wrong-answer failure this project keeps fighting is
 * most likely: a truncated file, a hand-patched header or a packed binary all
 * produce bytes that parse without error and describe as something real.
 *
 * It is deliberately separate from parsing. A reader that reported a problem by
 * returning null would make "this binary is damaged" indistinguishable from "this
 * binary does not have that", which is the same conflation `a2o` was fixed for.
 * So parsing stays permissive and this reports alongside it.
 *
 * ## What is checked, and what is not
 *
 * Only things that can be decided from the bytes alone, and only where being
 * wrong would change a tool's answer:
 *
 *   - header flag bits with no name in `loader.h`;
 *   - fewer readable load commands than the header's `ncmds` claims, which means
 *     the walk was cut short and the section and symbol tables may be incomplete;
 *   - a section or segment claiming bytes past the end of its slice;
 *   - a symbol or string table reaching past the slice;
 *   - the symbol and string tables overlapping each other, which no legitimate
 *     linker output does;
 *   - a string table whose byte distribution is too flat to be text.
 *
 * Deliberately not checked: an `LC_MAIN` entry point outside `__TEXT`. That is the
 * normal state of a dyld shared-cache stub and, measured, also true of a
 * fully-symbolled 113 MB `node` — so the check fired on essentially every correct
 * binary this package is pointed at. A warning that is always true teaches a
 * reader to skip warnings; the raw offset is reported in `entryPoint` instead, and
 * whether it lands in `__TEXT` is disclosed there as a fact rather than a verdict.
 *
 * Deliberately *not* checked: unknown load commands. Those are already surfaced
 * by `loadCommandName` as a number rather than a name, which is this project's
 * chosen line for "present but not understood", and listing them a second time
 * as abnormalities would grade an unfamiliar-but-valid command as damage.
 *
 * ## On the packing heuristic
 *
 * Entropy is a heuristic and is labelled as one. Printable text sits around
 * 4.5-5.2 bits per byte and compressed or encrypted data near 8, so the
 * threshold sits in the empty gap between them — but obfuscated-but-not-compressed
 * data lands above it, and a legitimately compressed string table would land
 * above it too. It says "look at this", never "this is packed".
 *
 * @param {object} f an `opener()` handle
 * @param {object} thin a `parseThin()` result
 * @param {object} [opts]
 * @param {number} [opts.sliceOffset=0] the slice's offset within the file
 * @param {number} [opts.sliceSize] the slice's size; defaults to the rest of the file
 * @returns {Array<{kind: string, detail: string}>}
 */
export function detectAbnormalities(f, thin, { sliceOffset = 0, sliceSize = null } = {}) {
  const out = [];
  const sliceEnd = sliceSize == null ? f.size - sliceOffset : sliceSize;
  /**
   * Record one finding.
   *
   * `severity` is the distinction that lets this be used as a build gate rather
   * than only as a report, and it is drawn on one question: **can the reader's
   * answers still be trusted?**
   *
   *   `error`   — the file disagrees with itself. A size or an extent points at
   *               bytes that are not there, so anything computed from it may be
   *               wrong. A build should fail on these.
   *   `warning` — the file parsed and the answers are probably right, but
   *               something is unfamiliar (a flag or attribute bit this header
   *               does not name) or explicitly heuristic (the entropy probe).
   *
   * The two unfamiliar-bit checks are warnings rather than errors on purpose. A
   * binary built by a newer Xcode than this reader knows about sets a flag bit
   * that has no name yet, and failing a build over that would make the gate
   * useless within one toolchain release. The caller who wants the stricter
   * reading asks for it — `audit --strict` — and a gate that only ever fires on
   * genuine damage is a gate people leave switched on.
   */
  const add = (kind, detail, severity = 'error') => out.push({ kind, detail, severity });

  // Header flags this table cannot name. A real binary can set a bit added after
  // this reader was written, so the detail says "unrecognised" rather than
  // "corrupt" — it is a claim about the names, not about the file.
  const hdr = decodeHeaderFlags(thin.flags);
  if (hdr.unknown !== 0) {
    add(
      'unknown-header-flags',
      `header sets flag bits with no name in <mach-o/loader.h>: 0x${hdr.unknown.toString(16)}`,
      'warning',
    );
  }

  if (thin.loadCommands.length < thin.ncmds) {
    add(
      'load-commands-truncated',
      `header declares ${thin.ncmds} load command(s), only ${thin.loadCommands.length} were readable — ` +
        'the segment, section and symbol tables below may be incomplete',
    );
  }

  // Sections past the slice. Gated on `isBackedByFile`, which is what separates
  // "claims bytes that are not there" from "__bss legitimately occupies no bytes":
  // a zero-fill section carries a real address range and a `size` that can easily
  // exceed the file, and flagging it would be flagging every ordinary binary.
  for (const sec of thin.sections) {
    if (sec.size === 0) continue;
    if (!isBackedByFile(thin, sec)) continue;
    if (sec.offset + sec.size > sliceEnd) {
      add(
        'section-past-slice-end',
        `${sec.segname},${sec.sectname} claims bytes ${sec.offset}..${sec.offset + sec.size}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    if (sec.attributesUnknown !== 0) {
      add(
        'unknown-section-attributes',
        `${sec.segname},${sec.sectname} sets attribute bits with no name in <mach-o/loader.h>: ` +
          `0x${sec.attributesUnknown.toString(16)}`,
        'warning',
      );
    }
    if (sec.type.startsWith('S_UNKNOWN_')) {
      add(
        'unknown-section-type',
        `${sec.segname},${sec.sectname} has section type 0x${sec.typeRaw.toString(16)}, ` +
          'which <mach-o/loader.h> does not define',
        'warning',
      );
    }
  }

  for (const seg of thin.segments) {
    const hi = seg.fileoff + seg.filesize;
    if (hi > sliceEnd) {
      add(
        'segment-past-slice-end',
        `${seg.segname} claims file bytes ${seg.fileoff}..${hi}, past the end of the slice at ${sliceEnd}`,
      );
    }
  }

  const st = thin.symtab;
  if (st) {
    // The stride differs between `nlist` (12) and `nlist_64` (16), so it is taken
    // from the parse rather than written as a constant — the same trap that once
    // read every symbol in a 32-bit slice one entry off.
    const stride = thin.is64 ? 16 : 12;
    const symEnd = st.symoff + st.nsyms * stride;
    if (st.nsyms > 0 && symEnd > sliceEnd) {
      add(
        'symtab-past-slice-end',
        `LC_SYMTAB claims ${st.nsyms} symbol(s) in bytes ${st.symoff}..${symEnd}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    const strEnd = st.stroff + st.strsize;
    if (st.strsize > 0 && strEnd > sliceEnd) {
      add(
        'strtab-past-slice-end',
        `LC_SYMTAB claims a string table in bytes ${st.stroff}..${strEnd}, ` +
          `past the end of the slice at ${sliceEnd}`,
      );
    }
    if (st.nsyms > 0 && st.strsize > 0
      && st.symoff < strEnd && st.stroff < symEnd) {
      add(
        'symtab-strtab-overlap',
        `the symbol table (${st.symoff}..${symEnd}) and the string table (${st.stroff}..${strEnd}) ` +
          'overlap — no linker emits this, and a reader cannot trust either extent',
      );
    }
    if (st.strsize > 0) {
      const h = shannonEntropy(f, sliceOffset + st.stroff, st.strsize);
      if (h > PACKED_ENTROPY) {
        add(
          'strtab-high-entropy',
          `the string table averages ${h.toFixed(2)} bits/byte over its first ` +
            `${Math.min(st.strsize, 1 << 20)} bytes — above the ~6.4 threshold, ` +
            'so it may be compressed or obfuscated rather than plain text',
          'warning',
        );
      }
    }
  }

  return out;
}

/**
 * Structural problems with the *fat container* — the table of slices, rather than
 * anything inside a slice.
 *
 * ## Why this is separate from {@link detectAbnormalities}
 *
 * That function answers "does this slice hold together?", and every check in it is
 * about bytes reachable from one Mach-O header. None of them can see a slice that
 * overlaps its neighbour, because each slice is perfectly self-consistent in
 * isolation — two slices claiming the same file range are individually fine and
 * jointly a lie, and a per-slice check structurally cannot notice.
 *
 * So the fat table gets its own pass. It is small, and the three things that
 * matter are all cross-slice:
 *
 *   - **overlapping slices.** Two slices claiming the same bytes means a reader
 *     that maps an address through "the richest slice" can silently pick either,
 *     and which one it picked depends on symbol counts rather than on anything the
 *     file says. This is the check that most changes what a tool reports, because
 *     it makes an existing ambiguity *visible* rather than resolving it silently.
 *   - **a slice reaching past the end of the file.** Truncation, the usual cause.
 *   - **a misaligned slice offset.** dyld requires slices to start on a 16 KiB
 *     boundary. A file that violates it still parses — this reader reads slice
 *     offsets from the table rather than assuming them — so it is a warning about
 *     the producer, not a claim that the bytes are unreadable.
 *
 * Alignment is deliberately a *warning* and overlap a *error*, for the same
 * reason the unfamiliar-bit checks are warnings: only one of them means a reader's
 * answers cannot be trusted. A misaligned slice is read correctly by this reader
 * and by every other that reads the table; overlapping slices mean two different
 * answers are equally available.
 *
 * @param {object} f an `opener()` handle
 * @returns {Array<{kind: string, detail: string, severity: string}>} empty for a
 *   well-formed container, and also empty for a thin binary — a thin file has no
 *   fat table to be inconsistent with, and reporting nothing is the honest answer
 *   rather than reporting "0 slices".
 */
export function detectContainerAbnormalities(f) {
  const out = [];
  const fat = parseFat(f);
  if (!fat) return out;
  const add = (kind, detail, severity = 'error') => out.push({ kind, detail, severity });

  for (const s of fat) {
    if (s.offset + s.size > f.size) {
      add(
        'slice-past-file-end',
        `the ${sliceArchName(s.cputype, s.cpusubtype)} slice claims bytes ${s.offset}..${s.offset + s.size}, ` +
          `past the end of a ${f.size}-byte file`,
      );
    }
    if (s.offset % FAT_SLICE_ALIGN !== 0) {
      add(
        'slice-misaligned',
        `the ${sliceArchName(s.cputype, s.cpusubtype)} slice starts at 0x${s.offset.toString(16)}, ` +
          `which is not a ${FAT_SLICE_ALIGN / 1024} KiB boundary — dyld requires alignment, ` +
          'so this file was not produced by a current linker',
        'warning',
      );
    }
  }

  // Overlap, by pairwise extent comparison rather than by sorting. A fat table has
  // a handful of slices, so the quadratic form is not worth optimising and keeps
  // the reporting order the same as the table's own order, which is what a reader
  // comparing two files wants to see.
  for (let i = 0; i < fat.length; i++) {
    for (let j = i + 1; j < fat.length; j++) {
      const a = fat[i];
      const b = fat[j];
      const lo = Math.max(a.offset, b.offset);
      const hi = Math.min(a.offset + a.size, b.offset + b.size);
      if (lo < hi) {
        add(
          'slices-overlap',
          `the ${sliceArchName(a.cputype, a.cpusubtype)} slice (${a.offset}..${a.offset + a.size}) and the ` +
            `${sliceArchName(b.cputype, b.cpusubtype)} slice (${b.offset}..${b.offset + b.size}) both claim ` +
            `bytes ${lo}..${hi} — which slice a reader used would change the answer`,
        );
      }
    }
  }

  return out;
}

/**
 * dyld's required alignment for a fat slice's starting offset: 2^14.
 *
 * A named constant rather than a literal at the use site, because the value is a
 * property of the loader's contract rather than of this check, and the next reader
 * to need it should not have to re-derive it.
 */
const FAT_SLICE_ALIGN = 1 << 14;

/**
 * Map a file offset to a vaddr within a parsed slice, or null if unmapped.
 * Used to turn a literal's file offset into the address a tool must cite.
 *
 * Zero-fill sections are skipped. They are listed first-and-foremost as sections
 * but have no bytes, so a file offset inside one belongs to whatever actually
 * occupies that range — usually the header. See `isBackedByFile`.
 */
export function toVaddr(thin, fileOff) {
  for (const s of thin.sections) {
    if (!isBackedByFile(thin, s)) continue;
    if (fileOff >= s.offset && fileOff < s.offset + s.size) {
      return {
        vaddr: s.addr + BigInt(fileOff - s.offset),
        section: `${s.segname},${s.sectname}`,
      };
    }
  }
  for (const s of thin.segments) {
    if (fileOff >= Number(s.fileoff) && fileOff < Number(s.fileoff) + Number(s.filesize)) {
      return {
        vaddr: s.vmaddr + BigInt(fileOff - Number(s.fileoff)),
        section: `${s.segname} (segment)`,
      };
    }
  }
  return null;
}

/**
 * Map a vaddr to a file offset within a parsed slice, or null.
 *
 * The inverse of `toVaddr`, and the half that needs the zero-fill check more
 * urgently: `__bss` has an address and a size, so a vaddr inside it *looks*
 * mappable, but no byte of it exists in the file. Returned as
 * `{ zerofill: true }` rather than null, because "this address exists but is not
 * in the file" and "this address is not in this binary" are different answers
 * and a caller patching a file needs to tell them apart.
 *
 * Sections first, then segments, mirroring `toVaddr`: a section is the tighter
 * answer, and the segment range is what covers the padding between them.
 */
export function toFileOffset(thin, vaddr) {
  for (const s of thin.sections) {
    if (vaddr < s.addr || vaddr >= s.addr + BigInt(s.size)) continue;
    if (!isBackedByFile(thin, s)) {
      return {
        offset: null,
        zerofill: true,
        section: `${s.segname},${s.sectname}`,
        segname: s.segname,
      };
    }
    return {
      offset: s.offset + Number(vaddr - s.addr),
      zerofill: false,
      section: `${s.segname},${s.sectname}`,
      segname: s.segname,
    };
  }
  for (const s of thin.segments) {
    if (vaddr < s.vmaddr || vaddr >= s.vmaddr + s.vmsize) continue;
    const delta = vaddr - s.vmaddr;
    // Past `filesize` the segment is mapped but absent from the file: the tail of
    // a `__DATA` that runs into `__bss`, or all of `__PAGEZERO`.
    if (delta >= s.filesize) {
      return {
        offset: null,
        zerofill: true,
        section: `${s.segname} (segment)`,
        segname: s.segname,
      };
    }
    return {
      offset: Number(s.fileoff) + Number(delta),
      zerofill: false,
      section: `${s.segname} (segment)`,
      segname: s.segname,
    };
  }
  return null;
}

/** The section containing a file offset, or null. */
export function sectionOf(thin, fileOff) {
  return thin.sections.find(
    (s) => isBackedByFile(thin, s) && fileOff >= s.offset && fileOff < s.offset + s.size,
  ) || null;
}

/**
 * Find a byte string inside a section, stopping early per needle.
 *
 * Scoped to `__TEXT` rather than the whole file: literals live there, and a
 * whole-file sweep of a 476 MB universal binary is slow enough that tools end
 * up not being run. The `overlap` window carries a match that straddles a
 * chunk boundary, which a naive chunked scan silently drops.
 *
 * `sliceBase` is the slice's file offset within the file. A section's `offset`
 * is slice-relative, so on a universal binary this reads the wrong bytes without
 * it — see `scanSection` in `api.mjs` for the full account of how that stayed
 * hidden. Returns absolute file offsets and vaddrs.
 */
export function findInSection(
  f,
  sec,
  needles,
  { perNeedle = 4, chunk = 1 << 24, overlap = 64, sliceBase = 0 } = {},
) {
  const found = new Map();
  if (!sec || sec.size === 0) return { hits: found, scanned: 0, available: false };
  const enc = needles.map((n) => Buffer.from(n, 'latin1'));
  const start = sliceBase + sec.offset;
  const end = start + sec.size;
  let pos = start;
  let carry = Buffer.alloc(0);
  let carryBase = start;
  let scanned = 0;

  while (pos < end) {
    const buf = f.read(pos, Math.min(chunk, end - pos));
    if (buf.length === 0) break;
    scanned += buf.length;
    const hay = Buffer.concat([carry, buf]);
    const base = carryBase;

    for (let i = 0; i < enc.length; i++) {
      const key = needles[i];
      const list = found.get(key) || [];
      if (list.length >= perNeedle) continue;
      let from = 0;
      while (list.length < perNeedle) {
        const at = hay.indexOf(enc[i], from);
        if (at < 0) break;
        const abs = base + at;
        const pre = hay.subarray(Math.max(0, at - 16), at);
        list.push({
          off: abs,
          vaddr: sec.addr + BigInt(abs - start),
          section: sec.sectname,
          ctx: pre.toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(-16),
        });
        from = at + 1;
      }
      found.set(key, list);
    }

    if (needles.every((n) => (found.get(n) || []).length >= perNeedle)) break;
    carry = hay.subarray(Math.max(0, hay.length - overlap));
    carryBase = base + hay.length - carry.length;
    pos += buf.length;
  }
  return { hits: found, scanned, available: true };
}

