/*
 * The capture data model, and the substrate that produces one.
 *
 * A capture is a set of NAMED STREAMS produced by running one built program on
 * one backend. "serial" is the only stream today, but it is always addressed by
 * name: nothing here is called "the serial log" and no shape has a serial field,
 * so a backend that also records, say, a frame stream or a dmesg stream is added
 * by extending STREAMS rather than by changing every signature.
 *
 * Nothing in this file knows what a capture will be used for. The A/B diff in
 * ../ab.js is one consumer; a determinism check that never diffs anything is
 * another (ab.js `verify`). Keep it that way -- no diff vocabulary here.
 *
 * The backend is the only part of the pipeline that is bound to how a program is
 * run: `hw` flashes a board and reads its serial device, `sim` runs the compiled
 * JS headlessly in this process's node. Both write the same stream, byte for
 * byte, and both use the same exit codes, so everything downstream is blind to
 * which one produced the bytes.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const abDir = path.resolve(__dirname, "..");

// The token the captured programs print their banner and verdict with:
// "<MARKER> START <case>", "<MARKER> PASS <case>". It is a property of the
// generated program and of the capture backends that read a verdict out of the
// stream, so it lives here rather than in any one of them.
const MARKER = "HWAB";

// Verdict exit codes. Every backend reports exactly these, so a caller can tell
// "the program failed" from "the harness could not run anything" without
// knowing which backend ran.
const EXIT = {
    PASS: 0,
    FAIL: 1,
    TIMEOUT: 2,
    SETUP: 3
};

const EXIT_NAMES = {
    0: "pass",
    1: "fail",
    2: "timeout",
    3: "setup"
};

// Stream registry. `ext` is the file extension a stream of this kind is stored
// under, `encoding` is how its bytes are read back for reporting -- latin1
// because an undecodable byte from a real serial line has to survive a round
// trip and be reported as itself rather than as U+FFFD.
const STREAMS = {
    serial: {
        id: "serial",
        ext: ".log",
        encoding: "latin1",
        description: "everything the program printed, in order"
    }
};

// Backend registry. `artifact` names the kind of built artifact the backend
// consumes (see ARTIFACTS in cases.js); `streams` is what it can record;
// `marker` is fixed when the backend hard-codes the verdict token and cannot be
// told another one.
const BACKENDS = {
    hw: {
        id: "hw",
        script: path.join(abDir, "backends", "hw.js"),
        artifact: "hex",
        streams: ["serial"],
        marker: MARKER,
        fixedMarker: true,
        // A board carries its own runtime; there is nothing to point at.
        runtimeFlags: null,
        description: "flash an attached board and read its serial device"
    },
    sim: {
        id: "sim",
        script: path.join(abDir, "backends", "sim.js"),
        artifact: "js",
        streams: ["serial"],
        marker: MARKER,
        fixedMarker: false,
        // The runtime is loaded out of a checkout, which the backend finds by
        // walking up from the artifact -- and cannot, once the artifact has
        // been collected somewhere else. The caller names it instead.
        runtimeFlags: { core: "--pxt-core", commonPackages: "--common-packages" },
        description: "run the compiled JS headlessly in this node process"
    }
};

function fail(msg) {
    throw new Error("capture: " + msg);
}

function streamIds() {
    return Object.keys(STREAMS);
}

function stream(id) {
    const s = STREAMS[id];
    if (!s) fail("no such stream '" + id + "' (known: " + streamIds().join(" ") + ")");
    return s;
}

function backendIds() {
    return Object.keys(BACKENDS);
}

function backend(id) {
    const b = BACKENDS[id];
    if (!b) fail("no such backend '" + id + "' (known: " + backendIds().join(" ") + ")");
    return b;
}

function defaultStream() {
    return STREAMS.serial.id;
}

// Where a stream of a capture named `name` is stored under `dir`. One file per
// stream, so several streams of the same capture sit side by side and a reader
// can tell them apart by extension.
function streamFile(dir, name, streamId) {
    return path.join(dir, name + stream(streamId).ext);
}

// A capture handle: a name, and a path per stream. `backendId` and `source` are
// filled in by run() and are documentation for whoever reads the handle back --
// nothing downstream branches on them.
function create(opts) {
    if (!opts || !opts.dir || !opts.name) fail("create needs { dir, name }");
    const ids = opts.streams || [defaultStream()];
    const streams = {};
    for (const id of ids) streams[id] = streamFile(opts.dir, opts.name, id);
    return {
        name: opts.name,
        dir: opts.dir,
        streams: streams,
        backendId: opts.backendId || "",
        source: opts.source || ""
    };
}

// A capture that already exists as a file on disk, with no backend behind it:
// a golden stream committed to the repo, or a log captured months ago. Reading,
// hashing and comparing work on it exactly as on a fresh capture.
function fromFile(file, streamId) {
    const id = streamId || defaultStream();
    const streams = {};
    streams[id] = path.resolve(file);
    return {
        name: path.basename(file, stream(id).ext),
        dir: path.dirname(path.resolve(file)),
        streams: streams,
        backendId: "file",
        source: path.resolve(file)
    };
}

function streamPath(capture, streamId) {
    const id = streamId || defaultStream();
    const p = capture.streams[id];
    if (!p) fail("capture '" + capture.name + "' has no '" + id + "' stream");
    return p;
}

function hasStream(capture, streamId) {
    const id = streamId || defaultStream();
    if (!capture.streams[id]) return false;
    try { return fs.statSync(capture.streams[id]).isFile(); } catch (e) { return false; }
}

function readStream(capture, streamId, encoding) {
    const id = streamId || defaultStream();
    return fs.readFileSync(streamPath(capture, id), encoding || stream(id).encoding);
}

function streamBytes(capture, streamId) {
    return fs.statSync(streamPath(capture, streamId)).size;
}

function hashStream(capture, streamId) {
    return crypto.createHash("sha256")
        .update(fs.readFileSync(streamPath(capture, streamId))).digest("hex");
}

// ---- running a backend ----------------------------------------------------

// Builds the argument vector for a backend run. Both backends take the built
// artifact and the stream file positionally and everything else as flags, which
// is the whole of the contract this layer depends on.
function backendArgs(b, opts, logFile) {
    const args = [opts.source, logFile];
    if (opts.timeout !== undefined && opts.timeout !== null)
        args.push("--timeout", String(opts.timeout));
    if (opts.expect) args.push("--expect", String(opts.expect));
    // Where the runtime lives, for a backend that has to be told. One that
    // carries its own ignores it, so a caller can always pass it.
    if (opts.runtime && b.runtimeFlags) {
        for (const key of Object.keys(b.runtimeFlags)) {
            if (opts.runtime[key]) args.push(b.runtimeFlags[key], opts.runtime[key]);
        }
    }
    if (opts.marker && opts.marker !== b.marker) {
        if (b.fixedMarker)
            fail("backend '" + b.id + "' always reads '" + b.marker +
                "' verdicts and cannot be told to read '" + opts.marker + "'");
        args.push("--marker", String(opts.marker));
    }
    for (const extra of opts.extra || []) args.push(String(extra));
    return args;
}

// Runs one backend once and returns its verdict. The exit code is passed back
// verbatim -- it is the verdict, and inventing a richer result here would put
// the interpretation in the wrong layer.
function run(opts) {
    if (!opts || !opts.backend) fail("run needs { backend }");
    const b = backend(opts.backend);
    const streamId = opts.stream || defaultStream();
    if (b.streams.indexOf(streamId) < 0)
        fail("backend '" + b.id + "' does not record a '" + streamId + "' stream");
    if (!opts.source) fail("run needs { source } -- the built artifact to run");
    if (!opts.capture) fail("run needs { capture }");

    const logFile = streamPath(opts.capture, streamId);
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });

    const args = backendArgs(b, opts, logFile);
    const res = spawnSync(process.execPath, [b.script].concat(args),
        { stdio: opts.stdio || "inherit" });
    if (res.error)
        return {
            code: EXIT.SETUP,
            backend: b.id,
            stream: streamId,
            path: logFile,
            error: res.error.message,
            stdout: "",
            stderr: "capture: could not run " + b.script + ": " + res.error.message
        };

    opts.capture.backendId = b.id;
    opts.capture.source = opts.source;
    return {
        code: res.status === null ? EXIT.SETUP : res.status,
        backend: b.id,
        stream: streamId,
        path: logFile,
        stdout: res.stdout ? String(res.stdout) : "",
        stderr: res.stderr ? String(res.stderr) : ""
    };
}

function exitName(code) {
    return EXIT_NAMES[code] || "exit " + code;
}

module.exports = {
    MARKER: MARKER,
    EXIT: EXIT,
    STREAMS: STREAMS,
    BACKENDS: BACKENDS,
    streamIds: streamIds,
    stream: stream,
    defaultStream: defaultStream,
    backendIds: backendIds,
    backend: backend,
    streamFile: streamFile,
    create: create,
    fromFile: fromFile,
    streamPath: streamPath,
    hasStream: hasStream,
    readStream: readStream,
    streamBytes: streamBytes,
    hashStream: hashStream,
    run: run,
    exitName: exitName
};
