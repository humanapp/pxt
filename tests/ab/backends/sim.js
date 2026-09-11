/*
 * Capture backend "sim": executes a pxt-compiled program headlessly in this
 * node process and captures the lines it prints.
 *
 * The "board" is pxsim running in-process, so there is no flashing, no
 * re-enumeration and no serial device -- the program's serial writes are
 * intercepted at pxsim's own BaseBoard.writeSerial and appended to <logfile>
 * byte for byte, in order.
 *
 * The other backend is backends/hw.js. Both take the built artifact and the
 * stream file positionally and report the same exit codes -- 0 pass, 1 fail,
 * 2 timeout, 3 the harness could not run anything -- which is what lets
 * everything downstream be blind to which one produced the bytes.
 *
 * Nothing here names a target. The two runtime layers it loads (pxt-core's
 * pxtsim.js and pxt-common-packages' common-sim.js) are shared by every target,
 * and the board is manufactured from the classes they define, so a capture of
 * the same program on two different targets is comparable byte for byte.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEFAULT_TIMEOUT = 120;
const DEFAULT_MARKER = "HWAB";

const USAGE = [
    "Usage: node tests/ab/backends/sim.js <binary.js> <logfile> [--timeout <sec>]",
    "           [--expect <case>] [--marker <token>] [--pxt-core <dir>]",
    "           [--common-packages <dir>] [--sim <file.js>]...",
    "",
    "Runs <binary.js> -- a project's built/debug/binary.js -- on the pxt simulator",
    "runtime inside this node process, and writes everything it prints to <logfile>",
    "as UTF-8.",
    "",
    "Verdicts are read only from the \"<marker> START\" banner onward, and",
    "--expect <case> additionally requires the banner (and the verdict) to name that",
    "case. The marker defaults to " + DEFAULT_MARKER + ", which is what the generated programs and",
    "diff-ab.js use.",
    "",
    "  exit 0  <marker> PASS seen",
    "  exit 1  ASSERT seen, or the program faulted",
    "  exit 2  timeout with neither (default --timeout " + DEFAULT_TIMEOUT + ")",
    "  exit 3  host problem -- no such binary, no runtime, bad arguments",
    "",
    "Runtime discovery walks up from the binary to the target checkout's",
    "node_modules and loads pxt-core/built/pxtsim.js and, when it is there,",
    "pxt-common-packages/built/common-sim.js. --pxt-core and --common-packages name",
    "those checkouts explicitly; --sim loads an extra simulator bundle on top and",
    "may be repeated."
].join("\n");

function usage(stream) {
    stream.write(USAGE + "\n");
}

// Exit 3 is reserved for "the harness could not run anything at all", so a CI
// gate can tell a broken checkout from a broken program.
function fail(msg) {
    process.stderr.write("run-capture-sim: " + msg + "\n");
    process.exit(3);
}

// ---- arguments ------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.indexOf("-h") >= 0 || argv.indexOf("--help") >= 0) {
    usage(process.stdout);
    process.exit(0);
}
if (argv.length < 2) {
    usage(process.stderr);
    process.exit(3);
}

const binary = argv[0];
const logFile = argv[1];
let timeout = DEFAULT_TIMEOUT;
let expectCase = "";
let marker = DEFAULT_MARKER;
let coreDir = "";
let cpDir = "";
const extraSims = [];

function value(i, name) {
    if (i + 1 >= argv.length) fail(name + " needs a value");
    return argv[i + 1];
}

for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--timeout") timeout = value(i++, arg);
    else if (arg === "--expect") expectCase = value(i++, arg);
    else if (arg === "--marker") marker = value(i++, arg);
    else if (arg === "--pxt-core") coreDir = value(i++, arg);
    else if (arg === "--common-packages") cpDir = value(i++, arg);
    else if (arg === "--sim") extraSims.push(value(i++, arg));
    else {
        usage(process.stderr);
        fail("unknown argument: " + arg);
    }
}

if (!/^[0-9]+$/.test(String(timeout))) fail("--timeout must be an integer");
timeout = parseInt(timeout, 10);
if (!marker) fail("--marker must not be empty");

let binaryIsFile = false;
try { binaryIsFile = fs.statSync(binary).isFile(); } catch (e) { binaryIsFile = false; }
if (!binaryIsFile) fail("no such binary: " + binary);

// ---- locate the runtime ---------------------------------------------------

// The two runtime layers are found relative to the built artifact: the project
// sits inside the target checkout, whose node_modules carries both. The
// overrides exist so a caller can point elsewhere.
function findUp(from, rel) {
    let dir = path.resolve(from);
    for (;;) {
        const p = path.join(dir, rel);
        if (fs.existsSync(p)) return p;
        const up = path.dirname(dir);
        if (up === dir) return null;
        dir = up;
    }
}

const pxtsimJs = coreDir
    ? path.join(coreDir, "built", "pxtsim.js")
    : findUp(path.dirname(binary), path.join("node_modules", "pxt-core", "built", "pxtsim.js"));
if (!pxtsimJs || !fs.existsSync(pxtsimJs))
    fail("cannot find pxt-core/built/pxtsim.js -- name the checkout with --pxt-core");

const commonSimJs = cpDir
    ? path.join(cpDir, "built", "common-sim.js")
    : findUp(path.dirname(binary), path.join("node_modules", "pxt-common-packages", "built", "common-sim.js"));

process.stdout.write("run-capture-sim: pxtsim     " + pxtsimJs + "\n");
process.stdout.write("run-capture-sim: common-sim " + (commonSimJs || "<none>") + "\n");

vm.runInThisContext(fs.readFileSync(pxtsimJs, "utf8"), { filename: pxtsimJs });
const pxsim = globalThis.pxsim;
if (!pxsim) fail("pxtsim.js did not define a pxsim namespace");

if (commonSimJs && fs.existsSync(commonSimJs))
    vm.runInThisContext(fs.readFileSync(commonSimJs, "utf8"), { filename: commonSimJs });
for (const s of extraSims) {
    if (!fs.existsSync(s)) fail("no such simulator bundle: " + s);
    vm.runInThisContext(fs.readFileSync(s, "utf8"), { filename: s });
}

// ---- headless board -------------------------------------------------------

// initBareRuntime replaces whole namespace objects (pxsim.control = {...}),
// which would drop everything common-sim.js just defined on them. Snapshot the
// real implementations and lay them back over the bare stubs afterwards.
const NAMESPACES = ["control", "basic", "serial", "pins", "loops", "pxtcore", "thread"];
const real = {};
for (const ns of NAMESPACES)
    if (pxsim[ns]) real[ns] = Object.assign({}, pxsim[ns]);

// A target's own simulator builds a board carrying one state object per
// hardware feature its packages use -- board().screenState, board().audioState
// and so on. pxsim's BareBoard carries none, so a package that touches one
// throws during startup before a line is ever printed. The board is therefore
// wrapped so that any missing "<feature>State" is manufactured on first read
// from the matching class in common-sim.js, and is an inert empty object when
// there is no such class. Every class involved comes from pxt-common-packages,
// which every target shares.
const STATE_ARGS = {
    // 16 palette entries is what makes ScreenState report 4bpp; with the
    // 2-colour default every image the program allocates would be 1bpp.
    screenState: [new Array(16).fill("#000000")],
    edgeConnectorState: [{ pins: [], servos: {} }],
    touchButtonState: [[]],
    thermometerState: [0]
};

function makeState(prop) {
    const clsName = prop.charAt(0).toUpperCase() + prop.slice(1);
    const cls = pxsim[clsName];
    if (typeof cls === "function") {
        try { return new cls(...(STATE_ARGS[prop] || [])); }
        catch (e) { /* constructor wants a real board; fall through */ }
    }
    return {};
}

function headlessBoard(board) {
    const made = Object.create(null);
    return new Proxy(board, {
        get(target, prop) {
            if (prop in target) return Reflect.get(target, prop, target);
            if (typeof prop === "string" && /State$/.test(prop)) {
                if (!(prop in made)) made[prop] = makeState(prop);
                return made[prop];
            }
            return Reflect.get(target, prop, target);
        },
        set(target, prop, value) {
            if (prop in target) { target[prop] = value; return true; }
            made[prop] = value;
            return true;
        },
        has(target, prop) {
            return prop in target || prop in made;
        }
    });
}

pxsim.initCurrentRuntime = function (msg) {
    pxsim.initBareRuntime();
    for (const ns of NAMESPACES) {
        if (!real[ns]) continue;
        pxsim[ns] = Object.assign(pxsim[ns] || {}, real[ns]);
    }
    pxsim.runtime.board = headlessBoard(pxsim.runtime.board);
};

// ---- capture --------------------------------------------------------------

fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
const logFd = fs.openSync(logFile, "w");
let captured = "";

// The program hands the sim a JS string of UTF-16 code units, so the stream is
// written as UTF-8. latin1 would be the byte-for-byte choice for a real serial
// line but silently truncates every code point above 255 -- U+4E2D would land
// in the stream as 0x2D.
function sink(s) {
    if (typeof s !== "string") s = String(s);
    captured += s;
    fs.writeSync(logFd, Buffer.from(s, "utf8"));
    // The verdict is read as the lines arrive, which is what the hw backend
    // does too. A program that keeps printing after its verdict -- the
    // generated PASS heartbeat repeats for a minute, and then the program
    // idles forever -- would otherwise be captured until the timeout, and
    // where the timeout fell would decide how many bytes the capture held.
    // Only a completed line is examined, so a verdict can never be read out
    // of a half-written one.
    if (!done && captured.charAt(captured.length - 1) === "\n") {
        const v = verdictNow();
        if (v !== null) finish(v);
    }
}

// BaseBoard.writeSerial coalesces into a debounced "bulkserial" message, so a
// run that ends before the debounce fires loses its tail. Writing straight
// through keeps the capture byte-exact and in order.
pxsim.BaseBoard.prototype.writeSerial = function (s) { sink(s); };

// console.log in user code reaches control.__log; common-sim's version also
// mirrors it to the host console with an "l>" prefix, which is noise here.
function installLogShim() {
    if (!pxsim.control) pxsim.control = {};
    pxsim.control.__log = function (priority, str) {
        pxsim.runtime.board.writeSerial(str);
    };
}

// The runtime posts serial messages at the driving window; there is no window
// here, and the bytes have already been taken at writeSerial.
pxsim.Runtime.messagePosted = function (msg) {
    if (msg && (msg.type === "serial" || msg.type === "bulkserial")) return;
};

let done = false;
let faulted = null;
let exitCode = 3;
let timer = null;

function finish(code) {
    if (done) return;
    done = true;
    exitCode = code;
    if (timer) clearTimeout(timer);
    try { fs.closeSync(logFd); } catch (e) { /* closed */ }
    report();
    process.exit(exitCode);
}

function splitLines(text) {
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function firstMatch(text, needle) {
    for (const line of splitLines(text)) if (line.indexOf(needle) >= 0) return line;
    return null;
}

// Verdict lines count only from the program's own START banner onward, which is
// what --expect pins to a named case. Returns null until the banner is seen.
function startNeedle() {
    return marker + " START" + (expectCase ? " " + expectCase : "");
}

function verdictBody(content) {
    const needle = startNeedle();
    const lines = splitLines(content);
    for (let i = 0; i < lines.length; i++)
        if (lines[i].indexOf(needle) >= 0) return lines.slice(i).join("\n");
    return null;
}

function verdictNow() {
    const body = verdictBody(captured);
    if (body === null) return null;
    if (firstMatch(body, "ASSERT ") !== null) return 1;
    const passNeedle = marker + " PASS" + (expectCase ? " " + expectCase : "");
    if (firstMatch(body, passNeedle) !== null) return 0;
    return null;
}

function report() {
    const body = verdictBody(captured);
    if (exitCode === 1 && faulted) {
        process.stderr.write("run-capture-sim: FAIL -- the program faulted:\n");
        process.stderr.write((faulted.message || String(faulted)) + "\n");
    } else if (exitCode === 1) {
        process.stderr.write("run-capture-sim: FAIL -- assertion failed:\n");
        process.stderr.write(firstMatch(body || captured, "ASSERT ") + "\n");
    } else if (exitCode === 0) {
        process.stdout.write("run-capture-sim: PASS -- " +
            firstMatch(body, marker + " PASS") + "\n");
    } else if (exitCode === 2) {
        process.stderr.write("run-capture-sim: TIMEOUT -- no " + marker +
            " PASS and no ASSERT within " + timeout + "s. Captured " +
            splitLines(captured).length + " line(s).\n");
    }
}

const code = fs.readFileSync(binary, "utf8");
const rt = new pxsim.Runtime({ type: "run", code: code });
installLogShim();

// A throw that reaches the top, or a panic, is the program failing -- the same
// class of outcome as a failed assertion, not a host problem.
rt.errorHandler = function (e) {
    faulted = e;
    finish(1);
};

timer = setTimeout(() => {
    const v = verdictNow();
    finish(v === null ? 2 : v);
}, timeout * 1000);

rt.run(function () {
    const v = verdictNow();
    finish(v === null ? 2 : v);
});
