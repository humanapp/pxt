/*
 * Cases: what gets run, where its project is written, and how it is built.
 *
 * This is the only file in the framework that knows anything about a target.
 * A pxt project has to sit inside a target checkout for the CLI to find the
 * target at all, the dependency that supplies the core APIs is named by the
 * target's pxtarget.json, and so is the supportedTargets stamp -- all of that
 * is here. The capture stage downstream is target-blind by construction, which
 * is why a capture of the same case on two different targets can be compared
 * byte for byte at all.
 *
 * A suite is a family of cases that share a generator and a project root:
 *
 *   langtest   the codegen corpus files from tests/compile-test/lang-test0
 *              plus a soak program, written to <target>/projects/hw-ab/.
 *              These are the programs the hardware A/B has always run, and
 *              the project root and pxt.json names are unchanged so an
 *              existing checkout keeps working.
 *   capture    small programs that exercise the capture channel itself --
 *              plain lines, whitespace, a very long line, a high-volume
 *              burst, number formatting, and the three ways a run can end.
 *              Written to <target>/projects/ab-capture/.
 *
 * Case sources for the capture suite are the .ts files in ../cases/; adding one
 * adds a case. Cases whose run does not end in a plain pass say so in EXPECT.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const capture = require("./capture");

const isWindows = process.platform === "win32";

const abDir = path.resolve(__dirname, "..");
const pxtDir = path.resolve(abDir, "..", "..");
const langTest0Dir = path.join(pxtDir, "tests", "compile-test", "lang-test0");
const caseSrcDir = path.join(abDir, "cases");

// Milliseconds the device idles before running anything, so that the host has
// time to reopen the serial device after the post-flash reset.
const START_DELAY_MS = 10000;
// Interval of the trailing PASS heartbeat and of the soak progress line.
const PASS_INTERVAL_MS = 2000;
const SOAK_INTERVAL_MS = 5000;
// How long the PASS heartbeat runs before the program goes quiet. It only has
// to outlast the post-flash re-enumeration the capture waits for; streaming
// past that is noise, and a board transmitting indefinitely is suspected of
// aggravating flash failures.
const PASS_WINDOW_MS = 60000;
const PASS_REPEATS = Math.round(PASS_WINDOW_MS / PASS_INTERVAL_MS);

const MARKER = capture.MARKER;

// langtest case name -> lang-test0 source file
const LANG_CASES = {
    "conditiontruthiness": "54conditiontruthiness.ts",
    "conditionlowering": "55conditionlowering.ts",
    "ifacedispatch": "56ifacedispatch.ts"
};

// What a built artifact of each kind is called inside a project, and what has
// to be passed to `pxt build` to produce it. The JS artifact is the sim
// backend's input; --debug is what asks for it today (see the note in
// ../README.md about a JS-only build flag).
const ARTIFACTS = {
    hex: {
        id: "hex",
        rel: ["built", "binary.hex"],
        ext: ".hex",
        buildArgs: [],
        description: "native image to flash"
    },
    js: {
        id: "js",
        rel: ["built", "debug", "binary.js"],
        ext: ".js",
        buildArgs: ["--js"],
        // `pxt build --js` is a JS-only build: no native image, no run, no
        // deploy. A CLI from before that flag existed rejects it, and a target
        // checkout pinned to an old tag carries such a CLI, so --debug is the
        // fallback: it is also a JS-only build, and it additionally emits
        // breakpoint instrumentation. The captured output of the two is
        // byte-identical, so which one built the artifact does not matter to
        // anything downstream.
        fallbackArgs: ["--debug"],
        fallbackWhen: "Unrecognized flag",
        description: "compiled JS the sim runtime executes"
    }
};

// Per-case expectations. Anything not named here is a plain pass: exit 0, and
// two captures of it are expected to be byte-identical.
//
//   exit    acceptable exit code(s) from a capture backend
//   timeout seconds to give the capture, when the default is wrong
//   stable  whether repeated captures are expected byte-identical (a program
//           that never reaches a verdict is cut off wherever the clock lands)
//   verdict whether the program prints a pass/fail verdict at all
//   verify  whether a plain capture of it means anything (the soak program is
//           captured for a duration with --soak, which is a different run)
const DEFAULT_EXPECT = {
    exit: [capture.EXIT.PASS],
    timeout: null,
    stable: true,
    verdict: true,
    verify: true
};

const EXPECT = {
    langtest: {
        soak: {
            exit: [capture.EXIT.PASS],
            stable: false,
            verdict: false,
            verify: false
        }
    },
    capture: {
        failing: { exit: [capture.EXIT.FAIL] },
        throwing: { exit: [capture.EXIT.FAIL] },
        hanging: { exit: [capture.EXIT.TIMEOUT], timeout: 5, stable: false, verdict: false }
    }
};

const SUITES = {
    langtest: {
        id: "langtest",
        projectRoot: "hw-ab",
        projectPrefix: "hw-ab-",
        // The pxt.json a langtest project gets is the one it has always had,
        // down to this string: an existing checkout regenerates in place.
        projectDescription: "hw-ab device project (generated) -- ",
        artifact: "hex",
        description: "lang-test0 codegen corpus plus a soak program",
        generate: generateLangtest,
        names: () => Object.keys(LANG_CASES).concat(["soak"])
    },
    capture: {
        id: "capture",
        projectRoot: "ab-capture",
        projectPrefix: "ab-",
        projectDescription: "ab capture case (generated) -- ",
        artifact: "js",
        description: "capture-channel fidelity and the three ways a run can end",
        generate: generateCaptureSuite,
        names: () => sourceCaseNames()
    }
};

function fail(msg) {
    throw new Error("cases: " + msg);
}

function suiteIds() {
    return Object.keys(SUITES);
}

function suite(id) {
    const s = SUITES[id];
    if (!s) fail("no such suite '" + id + "' (known: " + suiteIds().join(" ") + ")");
    return s;
}

function caseInfo(suiteId, name) {
    const table = EXPECT[suite(suiteId).id] || {};
    const info = Object.assign({}, DEFAULT_EXPECT, table[name] || {});
    info.name = name;
    info.suite = suiteId;
    return info;
}

function sourceCaseNames() {
    if (!fs.existsSync(caseSrcDir)) return [];
    return fs.readdirSync(caseSrcDir)
        .filter(f => /\.ts$/.test(f))
        .map(f => f.replace(/\.ts$/, ""))
        .sort();
}

// ---- target knowledge -----------------------------------------------------

// Resolves a target checkout: an explicit path, else PXT_TARGET_DIR, else the
// sibling pxt-microbit checkout -- the same resolution the hardware workflow
// has always used.
function resolveTarget(spec) {
    const wanted = spec || process.env.PXT_TARGET_DIR ||
        path.join(pxtDir, "..", "pxt-microbit");
    let dir = "";
    try {
        const resolved = fs.realpathSync(wanted);
        if (fs.statSync(resolved).isDirectory()) dir = resolved;
    } catch (e) {
        dir = "";
    }
    if (!dir || !fs.existsSync(path.join(dir, "pxtarget.json")))
        fail("no pxtarget.json in '" + wanted + "' (set PXT_TARGET_DIR or pass --target)");
    return dir;
}

// The three things a generated project needs from its target: which package
// supplies the core APIs, which target id to stamp, and which target version.
//
// Stamping the current target version keeps the target's "upgrades" rules from
// injecting extra dependencies (they are all gated on older versions). Without
// the stamp the project reads as version 0.0.0, pxt-microbit's missingPackage
// rules match it, and the build dies with an error like "Package not
// installed: microphone".
function targetInfo(targetDir) {
    const dir = resolveTarget(targetDir);
    const target = JSON.parse(fs.readFileSync(path.join(dir, "pxtarget.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return {
        dir: dir,
        id: target.id,
        corepkg: target.corepkg || "core",
        version: pkg.version
    };
}

// Where the two shared runtime layers live inside a target checkout. A backend
// that runs the program outside the checkout has to be told; only the ones that
// are actually there are reported.
function runtimeDirs(target) {
    const dirs = {};
    const core = path.join(target.dir, "node_modules", "pxt-core");
    const cp = path.join(target.dir, "node_modules", "pxt-common-packages");
    if (fs.existsSync(path.join(core, "built", "pxtsim.js"))) dirs.core = core;
    if (fs.existsSync(path.join(cp, "built", "common-sim.js"))) dirs.commonPackages = cp;
    return dirs;
}

function projectRoot(target, suiteId) {
    return path.join(target.dir, "projects", suite(suiteId).projectRoot);
}

function projectDir(target, suiteId, name) {
    return path.join(projectRoot(target, suiteId), name);
}

function casesFile(target, suiteId) {
    return path.join(projectRoot(target, suiteId), "cases.txt");
}

// ---- project generation ---------------------------------------------------

function writeProject(target, suiteId, name, mainTs, log) {
    const s = suite(suiteId);
    const dir = projectDir(target, suiteId, name);
    const deps = {};
    // Three levels up from <target>/projects/<root>/<case>/ is the checkout.
    deps[target.corepkg] = "file:../../../libs/" + target.corepkg;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pxt.json"), JSON.stringify({
        name: s.projectPrefix + name,
        description: s.projectDescription + name,
        dependencies: deps,
        files: ["main.ts"],
        targetVersions: { target: target.version },
        supportedTargets: [target.id]
    }, null, 4) + "\n");
    fs.writeFileSync(path.join(dir, "main.ts"), mainTs);
    if (log) log(dir + " (" + mainTs.length + " bytes main.ts)");
    return dir;
}

// Exact text of the host prelude's assert. Matching it exactly rather than by
// regex is deliberate: if the prelude changes shape, generation fails loudly
// instead of silently emitting a program whose failures are invisible.
const HOST_ASSERT =
    "function assert(cond: boolean, m?: string) {\n" +
    "    if (!cond) {\n" +
    "        throw `assertion failed: ${m || \"\"}`;\n" +
    "    }\n" +
    "}\n";

const DEVICE_ASSERT =
    "// ---- hw-ab generated replacement -------------------------------------\n" +
    "// The host prelude's assert throws. An uncaught throw on device is just\n" +
    "// panic 999, which does not say which assertion failed, so the device\n" +
    "// build prints the assertion id to serial first and then panics 45.\n" +
    "//% shim=pxtrt::panic\n" +
    "function panic(code2: number): void { }\n" +
    "\n" +
    "function assert(cond: boolean, m?: string) {\n" +
    "    if (!cond) {\n" +
    "        console.log(\"ASSERT \" + (m || \"?\"))\n" +
    "        control.dmesg(\"ASSERT \" + (m || \"?\"))\n" +
    "        // Panic does not flush serial; without this drain pause the tail\n" +
    "        // of the assert id is lost, and the id is the failure report.\n" +
    "        basic.pause(250)\n" +
    "        panic(45)\n" +
    "    }\n" +
    "}\n" +
    "// ---- end hw-ab generated replacement ----------------------------------\n";

function devicePrelude() {
    const src = fs.readFileSync(path.join(langTest0Dir, "lang-test0.ts"), "utf8");
    if (src.indexOf(HOST_ASSERT) < 0)
        fail("lang-test0.ts prelude no longer contains the expected throwing " +
            "assert -- update HOST_ASSERT in tests/ab/lib/cases.js");
    return src.replace(HOST_ASSERT, DEVICE_ASSERT);
}

function langtestHeader(name) {
    return [
        "// Generated by tests/ab/lib/cases.js -- do not edit.",
        "// Case: " + name,
        "",
        "// Serial capture cannot start until the board re-enumerates after",
        "// flashing, so nothing is printed for the first " + START_DELAY_MS + " ms.",
        "basic.pause(" + START_DELAY_MS + ")",
        "console.log(\"" + MARKER + " START " + name + "\")",
        "control.dmesg(\"" + MARKER + " START " + name + "\")",
        ""
    ].join("\n");
}

function langtestFooter(name) {
    return [
        "",
        "// Reaching here means every assertion held. Repeat the verdict for",
        "// " + Math.round(PASS_WINDOW_MS / 1000) + "s so a capture that could only attach after the board",
        "// re-enumerated still sees it, then go quiet without resetting.",
        "for (let hwabI = 0; hwabI < " + PASS_REPEATS + "; hwabI++) {",
        "    console.log(\"" + MARKER + " PASS " + name + "\")",
        "    control.dmesg(\"" + MARKER + " PASS " + name + "\")",
        "    basic.pause(" + PASS_INTERVAL_MS + ")",
        "}",
        "while (true) {",
        "    basic.pause(1000)",
        "}",
        ""
    ].join("\n");
}

// The soak body is written here rather than imported from the case files: it
// needs the allocation shapes those files exercise, not their assertions, and
// it has to run forever. The three shapes are the ones whose codegen the A/B
// is about -- string building in condition position, growth of a dynamically
// keyed map, and polymorphic interface dispatch over mixed receivers.
function soakBody() {
    return [
        "namespace Soak {",
        "    interface SoakIface {",
        "        soakVal(): number",
        "    }",
        "",
        "    class SoakClass implements SoakIface {",
        "        n: number",
        "        constructor(n: number) {",
        "            this.n = n",
        "        }",
        "        soakVal(): number {",
        "            return this.n",
        "        }",
        "    }",
        "",
        "    function useSoak(v: SoakIface): number {",
        "        return v.soakVal() + 1",
        "    }",
        "",
        "    // Freshly built strings and arrays evaluated in condition position.",
        "    function churnConditions() {",
        "        let s = \"x\"",
        "        let i = 0",
        "        while ((s + i).length < 24) {",
        "            i++",
        "            s = s + \"y\"",
        "        }",
        "        const base = [1, 2, 3, 4, 5]",
        "        let k = 0",
        "        let seen = 0",
        "        while (base.slice(0, (k % 5) + 1).length > 0 && k < 200) {",
        "            seen += base.slice(k % 5).length",
        "            k++",
        "        }",
        "        assert(seen == 600, \"soak:slice\")",
        "        let m = 0",
        "        while (({ v: m }).v < 150 || m < 0) m++",
        "        assert(m == 150, \"soak:obj\")",
        "    }",
        "",
        "    // A map grown by computed key, then discarded.",
        "    function churnMap() {",
        "        const o: any = {}",
        "        for (let i = 0; i < 60; i++) o[\"soakKey\" + i] = i",
        "        let tot = 0",
        "        for (let i = 0; i < 60; i++) tot += o[\"soakKey\" + i]",
        "        assert(tot == 1770, \"soak:map\")",
        "    }",
        "",
        "    // The same call site over class instances and object literals.",
        "    // The literal's lambda captures a call parameter rather than the",
        "    // loop variable: a closure over a `let` loop variable sees the",
        "    // loop's final value in static TypeScript, unlike standard",
        "    // TypeScript.",
        "    function mkSoakLit(v: number): SoakIface {",
        "        return { soakVal: () => v }",
        "    }",
        "",
        "    function churnDispatch() {",
        "        const mixed: SoakIface[] = []",
        "        for (let i = 0; i < 40; i++) {",
        "            if (i % 2 == 0) mixed.push(new SoakClass(i))",
        "            else mixed.push(mkSoakLit(i))",
        "        }",
        "        let tot = 0",
        "        for (const mm of mixed) tot += useSoak(mm)",
        "        assert(tot == 820, \"soak:dispatch\")",
        "    }",
        "",
        "    // Free bytes reported after a forced collection. Undefined until",
        "    // the first GC has run, hence the explicit control.gc() call.",
        "    function heapMetric(): string {",
        "        control.gc()",
        "        const st = control.gcStats()",
        "        if (!st) return \"free=na\"",
        "        return \"free=\" + st.lastFreeBytes +",
        "            \" min=\" + st.minFreeBytes +",
        "            \" total=\" + st.totalBytes +",
        "            \" numgc=\" + st.numGC",
        "    }",
        "",
        "    export function run() {",
        "        const t0 = control.millis()",
        "        let next = 0",
        "        while (true) {",
        "            churnConditions()",
        "            churnMap()",
        "            churnDispatch()",
        "            const el = control.millis() - t0",
        "            if (el >= next) {",
        "                const line = \"" + MARKER + " SOAK \" + el + \" \" + heapMetric()",
        "                console.log(line)",
        "                control.dmesg(line)",
        "                next = el + " + SOAK_INTERVAL_MS,
        "            }",
        "        }",
        "    }",
        "}",
        "",
        "Soak.run()",
        ""
    ].join("\n");
}

function generateLangtest(target, log) {
    const prelude = devicePrelude();
    const names = [];

    for (const name of Object.keys(LANG_CASES)) {
        const caseFile = path.join(langTest0Dir, LANG_CASES[name]);
        if (!fs.existsSync(caseFile)) fail("missing case file " + caseFile);
        const body = fs.readFileSync(caseFile, "utf8");
        writeProject(target, "langtest", name,
            langtestHeader(name) + prelude + "\n" + body + "\n" + langtestFooter(name),
            log);
        names.push(name);
    }

    // The soak program never passes or fails; it prints progress until the
    // operator stops it or the heap gives out.
    writeProject(target, "langtest", "soak",
        langtestHeader("soak") + prelude + "\n" + soakBody(), log);
    names.push("soak");
    return names;
}

// The capture cases are standalone programs: no prelude, no assert rewrite,
// nothing target-specific in their text. They are copied through verbatim so
// that what a case does is readable in ../cases/<name>.ts and nowhere else.
function generateCaptureSuite(target, log) {
    const names = sourceCaseNames();
    if (!names.length) fail("no case sources in " + caseSrcDir);
    for (const name of names) {
        const src = fs.readFileSync(path.join(caseSrcDir, name + ".ts"), "utf8");
        writeProject(target, "capture", name, src, log);
    }
    return names;
}

// Writes every project of a suite into the target checkout and records the case
// list beside them. cases.txt is what everything downstream iterates, so adding
// a case needs no edit anywhere else.
function generate(opts) {
    const suiteId = (opts && opts.suite) || "langtest";
    const s = suite(suiteId);
    const target = targetInfo(opts && opts.target);
    const log = opts && opts.log;
    const names = s.generate(target, log);
    fs.mkdirSync(projectRoot(target, suiteId), { recursive: true });
    fs.writeFileSync(casesFile(target, suiteId), names.join("\n") + "\n");
    return { target: target, suite: suiteId, root: projectRoot(target, suiteId), names: names };
}

// The generated cases.txt is authoritative. A suite whose projects have not
// been generated yet falls back to the names the suite would generate, so a
// listing works before the first run.
function enumerate(opts) {
    const suiteId = (opts && opts.suite) || "langtest";
    const s = suite(suiteId);
    let target = null;
    try { target = targetInfo(opts && opts.target); } catch (e) { target = null; }
    if (target) {
        const file = casesFile(target, suiteId);
        if (fs.existsSync(file)) {
            const names = fs.readFileSync(file, "utf8").split("\n")
                .map(l => l.replace(/\r$/, ""))
                .filter(l => l.length > 0);
            if (names.length) return { names: names, source: file, target: target };
        }
    }
    return { names: s.names(), source: "tests/ab/lib/cases.js", target: target };
}

// ---- building -------------------------------------------------------------

function artifact(id) {
    const a = ARTIFACTS[id];
    if (!a) fail("no such artifact '" + id + "' (known: " + Object.keys(ARTIFACTS).join(" ") + ")");
    return a;
}

function artifactPath(projDir, artifactId) {
    return path.join.apply(null, [projDir].concat(artifact(artifactId).rel));
}

// A PATH lookup, not a trial run: `pxt --version` exits nonzero when it is not
// invoked inside a target checkout, so its exit status cannot answer "is the
// CLI installed".
function onPath(cmd) {
    const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const exts = isWindows
        ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
        : [""];
    for (const dir of dirs) {
        for (const ext of exts) {
            try {
                fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK);
                return true;
            } catch (e) { /* keep looking */ }
        }
    }
    return false;
}

// Builds one project once.
//
// `pxtCli` names the compiler to build with: null is the `pxt` on PATH (this
// checkout, npm-linked), and a path to a pxt.js is the CLI that ships inside
// some other checkout -- which is how a leg can be pinned to a snapshot other
// than the one being developed.
function build(opts) {
    if (!opts || !opts.projectDir) fail("build needs { projectDir }");
    const a = artifact(opts.artifact || "hex");
    const proj = opts.projectDir;
    if (!fs.existsSync(proj)) fail("missing project " + proj);

    // A stale built/ can hand back the previous mode's output.
    fs.rmSync(path.join(proj, "built"), { recursive: true, force: true });

    const env = Object.assign({}, process.env);
    if (opts.switches) env.PXT_COMPILE_SWITCHES = opts.switches;
    else delete env.PXT_COMPILE_SWITCHES;

    const t0 = Date.now();

    // The log fd is handed to both stdout and stderr so the two interleave as
    // they did on a console. shell:true on Windows so the pxt.cmd shim resolves;
    // never with an explicit CLI path, where the child is node and the path was
    // computed here.
    function spawnBuild(buildArgs) {
        const args = ["build"].concat(buildArgs, opts.args || []);
        let stdio = ["ignore", "inherit", "inherit"];
        let logFd = null;
        if (opts.logPath) {
            fs.mkdirSync(path.dirname(path.resolve(opts.logPath)), { recursive: true });
            logFd = fs.openSync(opts.logPath, "w");
            stdio = ["ignore", logFd, logFd];
        }
        try {
            if (opts.pxtCli)
                return spawnSync(process.execPath, [opts.pxtCli].concat(args),
                    { cwd: proj, env: env, stdio: stdio });
            if (!onPath("pxt"))
                fail("no 'pxt' on PATH -- install the pxt CLI (npm i -g pxt), " +
                    "or name one with --pxt <path to pxt.js>");
            return spawnSync("pxt", args,
                { cwd: proj, env: env, stdio: stdio, shell: isWindows });
        } finally {
            if (logFd !== null) fs.closeSync(logFd);
        }
    }

    function saidInLog(needle) {
        if (!opts.logPath || !needle) return false;
        try {
            return fs.readFileSync(opts.logPath, "utf8").indexOf(needle) >= 0;
        } catch (e) {
            return false;
        }
    }

    const out = artifactPath(proj, a.id);
    let usedArgs = a.buildArgs;
    let res = spawnBuild(usedArgs);

    // A CLI older than the artifact's preferred flag rejects it by name. That
    // is not a build failure, it is a CLI from another snapshot, so the
    // fallback spelling is tried once. Recognising it needs the log, so a
    // caller that took the output itself gets the first result as it stands.
    if (res.status !== 0 && a.fallbackArgs && saidInLog(a.fallbackWhen)) {
        usedArgs = a.fallbackArgs;
        res = spawnBuild(usedArgs);
    }

    const ok = !res.error && res.status === 0 && fs.existsSync(out);
    return {
        ok: ok,
        status: res.error ? null : res.status,
        error: res.error ? res.error.message : "",
        artifact: a.id,
        buildArgs: usedArgs,
        artifactPath: out,
        seconds: Math.round((Date.now() - t0) / 1000),
        logPath: opts.logPath || ""
    };
}

module.exports = {
    ARTIFACTS: ARTIFACTS,
    SUITES: SUITES,
    suiteIds: suiteIds,
    suite: suite,
    caseInfo: caseInfo,
    resolveTarget: resolveTarget,
    targetInfo: targetInfo,
    runtimeDirs: runtimeDirs,
    projectRoot: projectRoot,
    projectDir: projectDir,
    casesFile: casesFile,
    generate: generate,
    enumerate: enumerate,
    artifact: artifact,
    artifactPath: artifactPath,
    build: build,
    onPath: onPath,
    pxtDir: pxtDir,
    caseSrcDir: caseSrcDir
};
