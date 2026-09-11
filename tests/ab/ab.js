/*
 * One entry point for the A/B workflow, and the layer-2 consumer of lib/.
 *
 * An A/B leg is (backend, target, snapshot): what runs the program, which
 * target checkout it is built in, and which compiler built it. `ab` runs two
 * legs of the same case and diffs what they printed. Only the capture stage is
 * bound to the backend -- generation, build and diff are shared by both legs.
 *
 * The underlying scripts take full paths, which are long enough to mistype and
 * are fully derivable from a case name and a side: every artifact of case C on
 * side S lives at <out>/<C>/<S>.{hex,js,log}. This wrapper does that
 * derivation, resolves a case name from any unique substring of it, and hands
 * the result to the backends, build-ab.js and diff-ab.js.
 *
 * `verify` is the other consumer, and it never diffs anything: it runs each
 * case N times, checks the captures are byte-identical, checks each run ended
 * with the exit code its case expects, and compares the same case across
 * targets. It is built from lib/capture.js, lib/cases.js and lib/verdict.js
 * alone, which is the standing check that layer 1 owes nothing to the diff.
 *
 * Paths are resolved from this file's location, never from the working
 * directory, so the command works from anywhere.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const capture = require("./lib/capture");
const cases = require("./lib/cases");
const verdict = require("./lib/verdict");

const abDir = __dirname;
const DEFAULT_OUT = path.join(abDir, "out");
const DEFAULT_SUITE = "langtest";
const SIDES = ["candidate", "reference"];
const DEFAULT_RUNS = 3;

// The soak program prints heap telemetry forever and never a PASS verdict, so a
// plain capture of it can only time out, and a soak-mode capture of any other
// case can only report a stall. Both mismatches are refused up front.
const SOAK_CASE = "soak";

const USAGE = [
    "Usage: node tests/ab/ab.js <command> [args]",
    "",
    "A/B capture and comparison. A leg is (backend, target, snapshot); `ab` runs",
    "two legs of one case and diffs them. Artifact paths are derived from the case",
    "name and the side, so only the case is ever typed: case C on side S is",
    "<out>/<C>/<S>.{hex,js,log}.",
    "",
    "Commands:",
    "  gen                          write the suite's projects into the target",
    "  build [args...]              build both sides; arguments pass through to",
    "                               build-ab.js unchanged (--help lists them)",
    "  capture <case> [side]        run one built artifact and capture its streams",
    "  diff <case>                  diff the case's candidate and reference streams",
    "  ab <case>                    capture both legs, then diff",
    "  verify                       N-run determinism, expected exit codes, and",
    "                               cross-target comparison for a whole suite",
    "  cases                        list the suite's cases and what exists now",
    "  help                         this text",
    "",
    "Common options:",
    "  --backend <hw|sim>   capture backend for both legs (default hw)",
    "  --suite <id>         case suite (default " + DEFAULT_SUITE + "; also: " +
        cases.suiteIds().filter(s => s !== DEFAULT_SUITE).join(" ") + ")",
    "  --target <dir>       target checkout (default $PXT_TARGET_DIR, else the",
    "                       sibling pxt-microbit)",
    "  --out <dir>          artifact root (default tests/ab/out)",
    "  --timeout <sec>      capture timeout",
    "",
    "ab options:",
    "  --candidate <leg>    leg spec for one side, overriding --backend",
    "  --reference <leg>    likewise; a leg is <backend>, <backend>@<target-dir>,",
    "                       or file:<path> for a stream captured earlier or",
    "                       committed as a golden file",
    "",
    "verify options:",
    "  --target <dir>       repeatable; two or more targets are compared to each",
    "                       other case by case",
    "  --runs <n>           captures per case (default " + DEFAULT_RUNS + ")",
    "  --case <name>        repeatable; only these cases",
    "  --pxt <pxt.js>       build with this CLI instead of the pxt on PATH --",
    "                       a target checkout's own node_modules/pxt-core/built/pxt.js",
    "                       pins the leg to that snapshot. --pxt target uses each",
    "                       target's own CLI, which is one pinned snapshot per leg",
    "  --no-build           projects are already built; capture only",
    "",
    "A case may be named exactly or by any unique substring of its name, so",
    "\"truthiness\" and \"iface\" resolve; an ambiguous substring like \"condition\"",
    "is rejected with the candidate list rather than guessed.",
    "",
    "Examples:",
    "  node tests/ab/ab.js build --v2-only --ref-switches \"<optOutSwitch,...>\"",
    "  node tests/ab/ab.js ab truthiness --backend hw",
    "  node tests/ab/ab.js ab hello --suite capture --candidate sim --reference file:golden/hello.log",
    "  node tests/ab/ab.js verify --suite capture --backend sim --target ../pxt-arcade --target ../pxt-microbit",
    "",
    "Exit codes: the invoked script's own code, verbatim; `ab` reports the first",
    "failing stage's; `verify` exits 1 if any verdict failed. 0 for help, 2 for an",
    "unknown command or bad arguments."
].join("\n");

function usage(stream) {
    stream.write(USAGE + "\n");
}

// Exit 2 is this wrapper's own "you asked for something I cannot turn into a
// command" code; it never overlaps with a child's, because no child runs.
function fail(msg) {
    process.stderr.write("ab: " + msg + "\n");
    process.exit(2);
}

function say(msg) {
    process.stdout.write("ab: " + msg + "\n");
}

// ---- options --------------------------------------------------------------

// Pulls the options every command shares out of an argument list and returns
// what is left, so each command parses only what is its own.
function options(argv, spec) {
    const opts = {
        backend: "hw",
        suite: DEFAULT_SUITE,
        targets: [],
        out: DEFAULT_OUT,
        timeout: null,
        runs: DEFAULT_RUNS,
        onlyCases: [],
        pxt: "",
        build: true,
        legs: {},
        rest: []
    };
    const wants = spec || {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) fail(arg + " needs a value");
            return argv[++i];
        };
        if (arg === "--backend") opts.backend = next();
        else if (arg === "--suite") opts.suite = next();
        else if (arg === "--target") opts.targets.push(next());
        else if (arg === "--out") opts.out = path.resolve(next());
        else if (arg === "--timeout") opts.timeout = next();
        else if (wants.source && arg === "--source") opts.source = next();
        else if (wants.soak && arg === "--soak") opts.soak = next();
        else if (wants.verify && arg === "--runs") opts.runs = next();
        else if (wants.verify && arg === "--case") opts.onlyCases.push(next());
        else if (wants.verify && arg === "--pxt") {
            const v = next();
            // "target" is each checkout's own CLI, which is the whole point of
            // a snapshot leg: two targets built by two pinned compilers.
            opts.pxt = v === "target" ? "target" : path.resolve(v);
        }
        else if (wants.verify && arg === "--no-build") opts.build = false;
        else if (wants.legs && arg === "--candidate") opts.legs.candidate = next();
        else if (wants.legs && arg === "--reference") opts.legs.reference = next();
        else if (arg.charAt(0) === "-") fail("unknown option: " + arg);
        else opts.rest.push(arg);
    }
    if (!capture.BACKENDS[opts.backend])
        fail("'" + opts.backend + "' is not a backend -- expected " +
            capture.backendIds().join(" or "));
    if (!cases.SUITES[opts.suite])
        fail("'" + opts.suite + "' is not a suite -- expected " +
            cases.suiteIds().join(" or "));
    if (opts.timeout !== null && !/^[0-9]+$/.test(String(opts.timeout)))
        fail("--timeout must be an integer");
    if (opts.soak !== undefined && !/^[1-9][0-9]*$/.test(String(opts.soak)))
        fail("--soak needs a positive whole number of minutes");
    if (!/^[1-9][0-9]*$/.test(String(opts.runs)))
        fail("--runs must be a positive whole number");
    opts.runs = parseInt(opts.runs, 10);
    return opts;
}

function targetOf(opts) {
    try {
        return cases.targetInfo(opts.targets.length ? opts.targets[0] : null);
    } catch (e) {
        fail(e.message.replace(/^cases: /, ""));
    }
}

// A leg is (backend, target, snapshot). `file:<path>` is the degenerate leg
// whose capture already exists -- a golden stream in the repo, or one captured
// on a board weeks ago. The snapshot is which compiler built the artifact,
// which is chosen when it is built, not when it is captured.
function parseLeg(spec, opts) {
    if (!spec) return { backend: opts.backend, target: null, file: "" };
    if (spec.indexOf("file:") === 0)
        return { backend: "", target: null, file: path.resolve(spec.slice(5)) };
    const at = spec.indexOf("@");
    const backend = at < 0 ? spec : spec.slice(0, at);
    const target = at < 0 ? null : spec.slice(at + 1);
    if (!capture.BACKENDS[backend])
        fail("'" + backend + "' is not a backend -- expected " +
            capture.backendIds().join(" or ") + ", or file:<path>");
    return { backend: backend, target: target, file: "" };
}

// ---- case names -----------------------------------------------------------

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// The generated cases.txt is authoritative -- it is what the build iterates.
// <out>/ is the fallback for a checkout with no target beside it, and is enough
// for anything that only reads already-built artifacts.
function knownCases(opts) {
    const listed = cases.enumerate({ target: opts.targets[0], suite: opts.suite });
    if (listed.names.length && listed.source !== "tests/ab/lib/cases.js")
        return listed;
    if (isDir(opts.out)) {
        const names = fs.readdirSync(opts.out)
            .filter(e => isDir(path.join(opts.out, e))).sort();
        if (names.length) return { names: names, source: opts.out };
    }
    return listed;
}

function resolveCase(name, opts) {
    const known = knownCases(opts);
    if (known.names.indexOf(name) >= 0) return name;
    const hits = known.names.filter(n => n.indexOf(name) >= 0);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1)
        fail("'" + name + "' matches more than one case: " + hits.join(" ") + "\n" +
            "  Name one of them exactly, or use a substring that only one contains.");
    fail("no case matches '" + name + "'. Known cases (from " + known.source + "):\n" +
        "  " + known.names.join(" "));
}

function resolveSide(name) {
    if (SIDES.indexOf(name) >= 0) return name;
    fail("'" + name + "' is not a side -- expected " + SIDES.join(" or "));
}

function caseDir(opts, caseName) {
    return path.join(opts.out, caseName);
}

function artifactFile(opts, caseName, side, backendId) {
    const b = capture.backend(backendId);
    return path.join(caseDir(opts, caseName),
        side + cases.artifact(b.artifact).ext);
}

function streamFile(opts, caseName, side, streamId) {
    return capture.streamFile(caseDir(opts, caseName), side,
        streamId || capture.defaultStream());
}

function buildHint(side, opts) {
    const suite = opts.suite === DEFAULT_SUITE ? "" : " --suite " + opts.suite;
    return side === "reference"
        ? "node tests/ab/ab.js build --v2-only --ref-switches \"<optOutSwitch,...>\"" + suite
        : "node tests/ab/ab.js build --candidate-only --v2-only" + suite;
}

function requireArtifact(opts, caseName, side, backendId) {
    const file = artifactFile(opts, caseName, side, backendId);
    let ok = false;
    try { ok = fs.statSync(file).isFile(); } catch (e) { ok = false; }
    if (!ok)
        fail("no " + side + " artifact for " + caseName + " at " + file + "\n" +
            "  Build it first: " + buildHint(side, opts));
    return file;
}

// ---- child processes ------------------------------------------------------

// Never shell:true: the child is always node running a script whose path this
// process computed, and a path with a space in it must not be re-parsed by a
// shell. spawnSync with an argument array is also the form that behaves the
// same on Windows as it does elsewhere.
function run(script, args) {
    const res = spawnSync(process.execPath,
        [path.join(abDir, script)].concat(args), { stdio: "inherit" });
    if (res.error) {
        process.stderr.write("ab: could not run " + script + ": " +
            res.error.message + "\n");
        return 1;
    }
    return res.status === null ? 1 : res.status;
}

// ---- commands -------------------------------------------------------------

function cmdGen(argv) {
    const opts = options(argv);
    if (opts.rest.length) fail("unexpected argument: " + opts.rest[0]);
    let result;
    try {
        result = cases.generate({
            target: opts.targets[0],
            suite: opts.suite,
            log: line => say(line)
        });
    } catch (e) {
        fail(e.message.replace(/^cases: /, ""));
    }
    say(result.names.length + " project(s) in " + result.root);
    return 0;
}

// Everything passes through to build-ab.js unchanged, except the backend: a
// build does not care which backend will run the artifact, only which kind of
// artifact to produce, so --backend is translated into --artifact here.
function cmdBuild(argv) {
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== "--backend") { args.push(argv[i]); continue; }
        if (i + 1 >= argv.length) fail("--backend needs a value");
        const id = argv[++i];
        if (!capture.BACKENDS[id])
            fail("'" + id + "' is not a backend -- expected " +
                capture.backendIds().join(" or "));
        args.push("--artifact", capture.BACKENDS[id].artifact);
    }
    return run("build-ab.js", args);
}

// Captures one side of one case. Deliberately quiet: the backend prints what it
// is doing, and a wrapper line on top of it would be noise.
function captureSide(opts, caseName, side, leg, extra) {
    const info = cases.caseInfo(opts.suite, caseName);
    const backendId = leg.backend || opts.backend;
    const source = opts.source || requireArtifact(opts, caseName, side, backendId);
    const handle = capture.create({ dir: caseDir(opts, caseName), name: side });
    const timeout = opts.timeout !== null ? opts.timeout : info.timeout;

    // A collected artifact sits outside the checkout it was built in, so the
    // leg's target is named explicitly. A backend that carries its own runtime
    // ignores this.
    let runtime = null;
    try {
        runtime = cases.runtimeDirs(
            cases.targetInfo(leg.target || opts.targets[0] || null));
    } catch (e) { /* no target checkout; the backend may not need one */ }

    const res = capture.run({
        backend: backendId,
        source: source,
        capture: handle,
        expect: caseName,
        timeout: timeout,
        runtime: runtime,
        extra: extra || [],
        stdio: "inherit"
    });
    return res.code;
}

function cmdCapture(argv) {
    const opts = options(argv, { legs: true, soak: true, source: true });
    const positional = opts.rest;
    if (!positional.length) fail("capture needs a case name (see: ab.js cases)");
    if (positional.length > 2) fail("unexpected argument: " + positional[2]);

    const caseName = resolveCase(positional[0], opts);
    const side = positional.length > 1 ? resolveSide(positional[1]) : "candidate";
    const soakMinutes = opts.soak === undefined ? null : opts.soak;

    // The soak program prints heap telemetry and no verdict, so a plain capture
    // of it can only time out, and a soak-mode capture of a program that does
    // print a verdict can only report a stall. Both mismatches are refused up
    // front. --soak belongs to the hw backend and passes through to it.
    if (caseName === SOAK_CASE && soakMinutes === null)
        fail("the " + SOAK_CASE + " program prints no verdict, so a plain capture " +
            "of it can only time out.\n  Give a duration: ab.js capture " +
            SOAK_CASE + " " + side + " --soak <minutes>");
    if (caseName !== SOAK_CASE && soakMinutes !== null)
        fail("--soak is for the " + SOAK_CASE + " case; " + caseName +
            " prints a verdict -- use a plain capture");

    const extra = soakMinutes === null ? [] : ["--soak", String(soakMinutes)];
    return captureSide(opts, caseName, side, parseLeg(opts.legs[side], opts), extra);
}

function cmdDiff(argv) {
    const opts = options(argv);
    if (!opts.rest.length) fail("diff needs a case name (see: ab.js cases)");
    if (opts.rest.length > 1) fail("unexpected argument: " + opts.rest[1]);
    const caseName = resolveCase(opts.rest[0], opts);

    const missing = SIDES.filter(s => !fs.existsSync(streamFile(opts, caseName, s)));
    if (missing.length)
        fail("no " + missing.join(" and ") + " capture for " + caseName + ":\n" +
            missing.map(s => "  " + streamFile(opts, caseName, s)).join("\n") + "\n" +
            "  Capture it first: " +
            missing.map(s => "ab.js capture " + caseName + " " + s).join(" ; "));

    return run("diff-ab.js", [streamFile(opts, caseName, "candidate"),
                              streamFile(opts, caseName, "reference"),
                              "--case", caseName]);
}

function cmdAb(argv) {
    const opts = options(argv, { legs: true });
    if (!opts.rest.length) fail("ab needs a case name (see: ab.js cases)");
    if (opts.rest.length > 1) fail("unexpected argument: " + opts.rest[1]);
    const caseName = resolveCase(opts.rest[0], opts);
    const info = cases.caseInfo(opts.suite, caseName);

    if (!info.verdict)
        fail(caseName + " prints no pass/fail verdict, so there is nothing for " +
            "ab to sequence.\n  Capture each side for a duration, then compare:\n" +
            "    ab.js capture " + caseName + " candidate --soak <minutes>\n" +
            "    ab.js capture " + caseName + " reference --soak <minutes>\n" +
            "    ab.js diff " + caseName);

    const legs = {};
    for (const side of SIDES) legs[side] = parseLeg(opts.legs[side], opts);

    // Every artifact is checked up front: a hardware run flashes the board once
    // per side, and discovering the second artifact is missing after the first
    // capture wastes the whole run.
    for (const side of SIDES)
        if (!legs[side].file) requireArtifact(opts, caseName, side, legs[side].backend);

    const stages = [];
    for (const side of SIDES) {
        if (legs[side].file) {
            // A file leg is already captured; the diff reads it where it lies.
            stages.push({
                name: "leg " + side + " (file)",
                run: () => {
                    if (!fs.existsSync(legs[side].file)) {
                        process.stderr.write("ab: no such capture: " + legs[side].file + "\n");
                        return 2;
                    }
                    return 0;
                }
            });
            continue;
        }
        stages.push({
            name: "capture " + side + " (" + legs[side].backend + ")",
            run: () => captureSide(opts, caseName, side, legs[side], [])
        });
    }
    stages.push({
        name: "diff",
        run: () => {
            const a = legs.candidate.file || streamFile(opts, caseName, "candidate");
            const b = legs.reference.file || streamFile(opts, caseName, "reference");
            return run("diff-ab.js", [a, b, "--case", caseName]);
        }
    });

    for (const stage of stages) {
        say("ab " + caseName + ": " + stage.name);
        const code = stage.run();
        if (code !== 0) {
            process.stderr.write("ab: ab " + caseName + " FAILED at stage '" +
                stage.name + "' (exit " + code + ")\n");
            return code;
        }
    }
    say("ab " + caseName + ": OK -- both legs passed and the captures agree");
    return 0;
}

function pad(s, width) {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function table(headers, rows, out) {
    const widths = headers.map((h, i) =>
        rows.reduce((w, r) => Math.max(w, r[i].length), h.length));
    const line = cells =>
        cells.map((c, i) => pad(c, widths[i])).join("  ").replace(/ +$/, "");
    out(line(headers));
    out(widths.map(w => "-".repeat(w)).join("  "));
    for (const row of rows) out(line(row));
}

function cmdCases(argv) {
    const opts = options(argv);
    if (opts.rest.length) fail("unexpected argument: " + opts.rest[0]);
    const known = knownCases(opts);
    const ext = cases.artifact(capture.backend(opts.backend).artifact).ext;

    const headers = ["case", "expect", "cand" + ext, "cand.log", "ref" + ext, "ref.log"];
    const rows = known.names.map(name => {
        const info = cases.caseInfo(opts.suite, name);
        return [
            name,
            info.exit.map(capture.exitName).join("|") + (info.verdict ? "" : " (no verdict)"),
            fs.existsSync(artifactFile(opts, name, "candidate", opts.backend)) ? "yes" : "-",
            fs.existsSync(streamFile(opts, name, "candidate")) ? "yes" : "-",
            fs.existsSync(artifactFile(opts, name, "reference", opts.backend)) ? "yes" : "-",
            fs.existsSync(streamFile(opts, name, "reference")) ? "yes" : "-"
        ];
    });

    process.stdout.write("ab: suite     " + opts.suite + "\n");
    process.stdout.write("ab: backend   " + opts.backend + "\n");
    process.stdout.write("ab: cases     " + known.source + "\n");
    process.stdout.write("ab: artifacts " + opts.out + "\n");
    process.stdout.write("\n");
    table(headers, rows, l => process.stdout.write(l + "\n"));
    return 0;
}

// ---- verify ---------------------------------------------------------------

// Runs a whole suite on one backend across one or more targets and reports the
// verdicts from lib/verdict.js. Nothing here diffs anything: this is the
// standing demonstration that the capture substrate and the verdicts stand on
// their own.
function cmdVerify(argv) {
    const opts = options(argv, { verify: true });
    if (opts.rest.length) fail("unexpected argument: " + opts.rest[0]);
    const backendId = opts.backend;
    const b = capture.backend(backendId);
    const artifactId = b.artifact;
    const targets = (opts.targets.length ? opts.targets : [null]).map(t => {
        try { return cases.targetInfo(t); } catch (e) { return fail(e.message.replace(/^cases: /, "")); }
    });

    const failures = [];
    const perTarget = {};

    for (const target of targets) {
        const label = path.basename(target.dir);
        const pxtCli = opts.pxt === "target"
            ? path.join(target.dir, "node_modules", "pxt-core", "built", "pxt.js")
            : (opts.pxt || null);
        if (pxtCli && !fs.existsSync(pxtCli)) fail("no such pxt CLI: " + pxtCli);
        const outDir = path.join(opts.out, "verify", label);
        fs.mkdirSync(outDir, { recursive: true });
        process.stdout.write("\n");
        say("target " + label + "  " + target.dir +
            "  (id=" + target.id + " corepkg=" + target.corepkg +
            " version=" + target.version + ")");

        const generated = cases.generate({ target: target.dir, suite: opts.suite });
        const names = generated.names.filter(n =>
            !opts.onlyCases.length || opts.onlyCases.indexOf(n) >= 0);
        say("suite " + opts.suite + ": " + names.join(" "));

        perTarget[label] = {};
        for (const name of names) {
            const info = cases.caseInfo(opts.suite, name);
            if (!info.verify) {
                say("  " + pad(label + "/" + name, 34) +
                    " skipped -- no plain capture of it says anything");
                continue;
            }
            const proj = cases.projectDir(target, opts.suite, name);
            let source = cases.artifactPath(proj, artifactId);

            if (opts.build) {
                const built = cases.build({
                    projectDir: proj,
                    artifact: artifactId,
                    pxtCli: pxtCli,
                    logPath: path.join(outDir, name + ".build.log")
                });
                if (!built.ok) {
                    process.stderr.write("ab: " + label + "/" + name +
                        " build FAILED (exit " + built.status + ", log " +
                        built.logPath + ")\n");
                    failures.push(label + "/" + name + ": build");
                    continue;
                }
                source = built.artifactPath;
                say(label + "/" + name + " built in " + built.seconds + "s");
            }
            if (!fs.existsSync(source)) {
                process.stderr.write("ab: " + label + "/" + name +
                    " has no built artifact at " + source + "\n");
                failures.push(label + "/" + name + ": no artifact");
                continue;
            }

            // An unstable case is captured once: its output is cut off wherever
            // the clock lands, so a second run says nothing a first one did not.
            const runs = info.stable ? opts.runs : 1;
            const captures = [];
            let lastCode = null;
            for (let r = 1; r <= runs; r++) {
                const handle = capture.create({
                    dir: outDir,
                    name: name + "-run" + r
                });
                const res = capture.run({
                    backend: backendId,
                    source: source,
                    capture: handle,
                    expect: name,
                    timeout: opts.timeout !== null ? opts.timeout : info.timeout,
                    runtime: cases.runtimeDirs(target),
                    stdio: ["ignore", "pipe", "pipe"]
                });
                lastCode = res.code;
                captures.push(handle);
            }

            const vs = [verdict.exitCode({ actual: lastCode, expected: info.exit })];
            if (info.stable) vs.push(verdict.determinism({ captures: captures }));
            for (const v of vs)
                say("  " + pad(label + "/" + name, 34) + " " + verdict.describe(v));
            for (const v of vs)
                if (!v.ok) failures.push(label + "/" + name + ": " + verdict.describe(v));

            perTarget[label][name] = { captures: captures, info: info };
        }

        // The setup exit code is a property of the backend, not of any case: a
        // built artifact that is not there at all has to be distinguishable
        // from a program that ran and failed.
        const missing = capture.create({ dir: outDir, name: "missing-artifact" });
        const res = capture.run({
            backend: backendId,
            source: path.join(outDir, "no-such-artifact" + cases.artifact(artifactId).ext),
            capture: missing,
            stdio: ["ignore", "pipe", "pipe"]
        });
        const v = verdict.exitCode({ actual: res.code, expected: capture.EXIT.SETUP });
        say("  " + pad(label + "/missing-artifact", 34) + " " + verdict.describe(v));
        if (!v.ok) failures.push(label + "/missing-artifact: " + verdict.describe(v));
    }

    // Cross-target: the same case, built and captured in two different target
    // checkouts. The capture stage is target-blind, so for a program that uses
    // nothing target-specific these are expected to agree byte for byte.
    const labels = Object.keys(perTarget);
    if (labels.length > 1) {
        process.stdout.write("\n");
        say("cross-target (" + labels.join(" vs ") + ")");
        const base = labels[0];
        for (const name of Object.keys(perTarget[base])) {
            const entry = perTarget[base][name];
            if (!entry.info.stable) continue;
            for (const other of labels.slice(1)) {
                const there = perTarget[other][name];
                if (!there) continue;
                const v = verdict.compare({
                    a: entry.captures[0],
                    b: there.captures[0]
                });
                say("  " + pad(name, 34) + " " + verdict.describe(v));
                if (!v.ok) failures.push("cross-target/" + name + ": " + verdict.describe(v));
            }
        }
    }

    process.stdout.write("\n");
    if (failures.length) {
        process.stderr.write("ab: verify FAILED\n");
        for (const f of failures) process.stderr.write("ab:   " + f + "\n");
        return 1;
    }
    say("verify OK");
    return 0;
}

// ---- dispatch -------------------------------------------------------------

function main(argv) {
    const cmd = argv[0];
    const rest = argv.slice(1);

    if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
        usage(process.stdout);
        return 0;
    }

    switch (cmd) {
        case "gen": return cmdGen(rest);
        case "build": return cmdBuild(rest);
        case "capture": return cmdCapture(rest);
        case "diff": return cmdDiff(rest);
        case "ab": return cmdAb(rest);
        case "cases": return cmdCases(rest);
        case "verify": return cmdVerify(rest);
    }

    usage(process.stderr);
    process.stderr.write("\nab: unknown command: " + cmd + "\n");
    return 2;
}

process.exitCode = main(process.argv.slice(2));
