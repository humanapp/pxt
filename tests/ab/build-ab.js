/*
 * Builds the candidate and reference artifacts for every case in a suite.
 *
 * The candidate is this checkout's compiler with no switches. The reference is
 * the same compiler with opt-out switches set, which is only meaningful when
 * the compiler actually implements them; see the identical-hash guard below.
 *
 * Both sides are built the same way whichever backend will run them: the
 * artifact kind is the only difference (a hex to flash, or the JS the sim
 * runtime executes), and it is chosen with --artifact. Generation and building
 * are shared by both legs of an A/B -- only the capture stage is bound to a
 * backend.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const cases = require("./lib/cases");

const abDir = __dirname;
const pxtDir = path.resolve(abDir, "..", "..");
const DEFAULT_OUT = path.join(abDir, "out");

const USAGE = [
    "Usage: node tests/ab/build-ab.js [options]",
    "",
    "Builds a suite's projects twice -- once as the candidate (this checkout's",
    "compiler, no switches) and once as the reference -- and collects the artifacts",
    "into <out>/<case>/{candidate,reference}.<ext>.",
    "",
    "Options:",
    "  --ref-switches \"<list>\"  compile switches for the reference build; required",
    "                           when both sides build in one run. Name the opt-out",
    "                           switches of the codegen change under test -- there",
    "                           is no default, because a wrong or missing switch",
    "                           name silently builds a second candidate (see",
    "                           below).",
    "  --v2-only                build only the V2/CODAL variant, by adding the",
    "                           csv---mbcodal variant selector to BOTH builds",
    "  --candidate-only         build only the candidate",
    "  --reference-only         build only the reference; without --ref-switches",
    "                           this builds the current checkout as-is and files",
    "                           it under reference.<ext> (the git-based strategy)",
    "  --suite <id>             case suite (default langtest; also: " +
        cases.suiteIds().filter(s => s !== "langtest").join(" ") + ")",
    "  --artifact <hex|js>      what to build (default: the suite's own kind --",
    "                           hex for a hardware leg, js for a sim leg)",
    "  --target <dir>           target checkout to build in",
    "  --out <dir>              artifact root (default tests/ab/out)",
    "  --pxt <pxt.js>           build with this CLI instead of the pxt on PATH;",
    "                           a target's own node_modules/pxt-core/built/pxt.js",
    "                           pins the build to that snapshot",
    "  -h, --help               this text",
    "",
    "Environment:",
    "  PXT_TARGET_DIR   target checkout (default: sibling ../pxt-microbit)",
    "",
    "Two reference strategies",
    "------------------------",
    "Switch-based (--ref-switches): one checkout, two builds, fast. It only",
    "works if the compiler on this branch implements the named opt-out switches.",
    "PXT parses PXT_COMPILE_SWITCHES name-agnostically, so an unknown switch is",
    "accepted silently and never read -- the \"reference\" is then byte-identical to",
    "the candidate for every case, which this script detects and fails on. Identical",
    "output for only some cases is normal (the switch gates a feature those programs",
    "do not use) and is reported as a note.",
    "",
    "It also only covers changes that are gated behind those switches. Any ungated",
    "change is present in both builds and invisible to the comparison.",
    "",
    "Git-based (gold standard): build the reference from a reference commit.",
    "",
    "    # reference side",
    "    git -C <pxt> checkout <reference-commit> && npm run build",
    "    node tests/ab/build-ab.js --reference-only --v2-only",
    "",
    "    # candidate side",
    "    git -C <pxt> checkout <candidate-branch> && npm run build",
    "    node tests/ab/build-ab.js --candidate-only --v2-only",
    "",
    "The two runs fill <out>/<case>/reference.<ext> and candidate.<ext> side by",
    "side; <out>/ is preserved between runs. That also means a stale artifact from",
    "an earlier run will happily pair with a fresh one -- check sizes.txt if in",
    "doubt.",
    "",
    "Exit codes: 0 built, 1 usage or build error, 3 identical-hash guard tripped."
].join("\n");

function usage(stream) {
    stream.write(USAGE + "\n");
}

function fail(msg) {
    process.stderr.write("build-ab: " + msg + "\n");
    process.exit(1);
}

let refSwitches = "";
let v2Only = false;
let doCandidate = true;
let doReference = true;
let suiteId = "langtest";
let artifactId = "";
let targetSpec = "";
let outDir = DEFAULT_OUT;
let pxtCli = "";

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
        if (i + 1 >= argv.length) fail(arg + " needs a value");
        return argv[++i];
    };
    if (arg === "--ref-switches") {
        refSwitches = next();
    } else if (arg === "--v2-only") {
        v2Only = true;
    } else if (arg === "--candidate-only") {
        doReference = false;
    } else if (arg === "--reference-only") {
        doCandidate = false;
    } else if (arg === "--suite") {
        suiteId = next();
    } else if (arg === "--artifact") {
        artifactId = next();
    } else if (arg === "--target") {
        targetSpec = next();
    } else if (arg === "--out") {
        outDir = path.resolve(next());
    } else if (arg === "--pxt") {
        pxtCli = path.resolve(next());
    } else if (arg === "-h" || arg === "--help") {
        usage(process.stdout);
        process.exit(0);
    } else {
        usage(process.stderr);
        fail("unknown argument: " + arg);
    }
}

if (!doCandidate && !doReference)
    fail("--candidate-only and --reference-only are mutually exclusive");

// A switch-less reference is only a hazard when the candidate builds in the
// same run -- it would be a second candidate and the A/B would compare a
// build with itself. Reference-only with no switches is the git-based
// strategy: the current checkout IS the reference.
if (doReference && doCandidate && !refSwitches)
    fail("building both sides in one run needs --ref-switches \"<list>\" " +
        "naming the opt-out switches of the change under test, or use the " +
        "git-based strategy (--reference-only / --candidate-only per " +
        "checkout; see --help)");

if (!cases.SUITES[suiteId])
    fail("'" + suiteId + "' is not a suite -- expected " + cases.suiteIds().join(" or "));
if (!artifactId) artifactId = cases.suite(suiteId).artifact;
if (!cases.ARTIFACTS[artifactId])
    fail("'" + artifactId + "' is not an artifact kind -- expected " +
        Object.keys(cases.ARTIFACTS).join(" or "));

let target;
try {
    target = cases.targetInfo(targetSpec || null);
} catch (e) {
    fail(e.message.replace(/^cases: /, ""));
}

if (!pxtCli) {
    if (!cases.onPath("pxt"))
        fail("no 'pxt' on PATH -- install the pxt CLI (npm i -g pxt), or name one " +
            "with --pxt <path to pxt.js>");
    if (!fs.existsSync(path.join(pxtDir, "built", "pxt.js")))
        fail("missing " + path.join(pxtDir, "built", "pxt.js") +
            " -- run 'npm run build' in " + pxtDir + " first");
} else if (!fs.existsSync(pxtCli)) {
    fail("no such pxt CLI: " + pxtCli);
}

const artifactExt = cases.artifact(artifactId).ext;

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pad(s, width) {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// The variant selector is not a compile switch; it picks the V2/CODAL-only
// build instead of the universal V1+V2 hex. It must be identical on both sides.
const variantSw = v2Only ? "csv---mbcodal" : "";

function joinSwitches(a, b) {
    return a && b ? a + "," + b : a + b;
}

process.stdout.write("build-ab: pxt      " + (pxtCli || pxtDir) + "\n");
process.stdout.write("build-ab: target   " + target.dir + "\n");
process.stdout.write("build-ab: suite    " + suiteId + " (" + artifactId + ")\n");
process.stdout.write("build-ab: variant  " + (variantSw || "<universal V1+V2>") + "\n");
process.stdout.write("build-ab: ref sw   " +
    (!doReference ? "<no reference build>" : refSwitches || "<none: checkout as-is>") + "\n");
process.stdout.write("\n");

let generated;
try {
    generated = cases.generate({
        target: target.dir,
        suite: suiteId,
        log: line => process.stdout.write("build-ab: gen " + line + "\n")
    });
} catch (e) {
    fail(e.message.replace(/^cases: /, ""));
}
process.stdout.write("build-ab: " + generated.names.length + " project(s) in " +
    generated.root + "\n\n");

function buildOne(caseName, mode, switches) {
    const proj = cases.projectDir(target, suiteId, caseName);
    const dest = path.join(outDir, caseName, mode + artifactExt);
    const logPath = path.join(outDir, caseName, mode + ".build.log");

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    process.stdout.write("build-ab: " + pad(caseName, 22) + " " + pad(mode, 10) +
        " switches=" + (switches || "<none>") + "\n");

    let built;
    try {
        built = cases.build({
            projectDir: proj,
            artifact: artifactId,
            switches: switches,
            pxtCli: pxtCli || null,
            logPath: logPath
        });
    } catch (e) {
        fail(e.message.replace(/^cases: /, ""));
    }

    if (!built.ok) {
        const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
        const lines = log.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        for (const line of lines) process.stderr.write("  | " + line + "\n");
        if (built.error) process.stderr.write("  | " + built.error + "\n");
        if (built.status === 0)
            fail(caseName + "/" + mode + " built no " + path.basename(built.artifactPath));
        fail(caseName + "/" + mode + " build failed (log above)");
    }

    fs.copyFileSync(built.artifactPath, dest);
    process.stdout.write("build-ab:   -> " + dest + " (" +
        fs.statSync(dest).size + " bytes, " + built.seconds + "s)\n");
}

fs.mkdirSync(outDir, { recursive: true });
const sizesFile = path.join(outDir, "sizes.txt");
fs.writeFileSync(sizesFile, [
    "# ab build " + new Date().toISOString().replace(/\.[0-9]{3}Z$/, "Z"),
    "# suite: " + suiteId + " artifact: " + artifactId,
    "# variant: " + (variantSw || "universal"),
    "# reference switches: " + refSwitches,
    "# case mode bytes sha256",
    ""
].join("\n"));

const identical = [];
let pairs = 0;

for (const caseName of generated.names) {
    fs.mkdirSync(path.join(outDir, caseName), { recursive: true });

    if (doCandidate) buildOne(caseName, "candidate", variantSw);
    if (doReference) buildOne(caseName, "reference", joinSwitches(variantSw, refSwitches));

    for (const mode of ["candidate", "reference"]) {
        const file = path.join(outDir, caseName, mode + artifactExt);
        if (!fs.existsSync(file)) continue;
        fs.appendFileSync(sizesFile, caseName + " " + mode + " " +
            fs.statSync(file).size + " " + sha256(file) + "\n");
    }

    if (doCandidate && doReference) {
        pairs++;
        if (sha256(path.join(outDir, caseName, "candidate" + artifactExt)) ===
            sha256(path.join(outDir, caseName, "reference" + artifactExt))) {
            identical.push(caseName);
        }
    }
    process.stdout.write("\n");
}

process.stdout.write("build-ab: sizes -> " + sizesFile + "\n");

// Some pairs identical is expected: a switch only changes the programs that use
// the feature it gates. Every pair identical is the failure mode worth catching
// -- the switch names buy nothing, so the A/B would compare a build with itself.
if (identical.length && identical.length === pairs) {
    process.stderr.write([
        "",
        "build-ab: ERROR -- candidate and reference artifacts are byte-identical for",
        "build-ab: every case:",
        "build-ab:  " + identical.join(" "),
        "",
        "The reference build differs from the candidate only by the compile switches",
        "\"" + refSwitches + "\". Identical output everywhere means those switches changed",
        "nothing at all. The likely cause is that the compiler on this branch does not",
        "implement them: PXT_COMPILE_SWITCHES is parsed name-agnostically, so an",
        "unrecognised switch name is accepted silently and then never read, and the",
        "\"reference\" build is just a second candidate build.",
        "",
        "Check that the switch names are spelled as the compiler reads them, or use the",
        "git-based reference strategy instead (build-ab.js --help). An A/B run against",
        "an identical artifact would compare a build with itself and always report",
        "\"same\".",
        ""
    ].join("\n"));
    process.exit(3);
}

for (const caseName of identical) {
    process.stdout.write("build-ab: note -- no codegen difference for " + caseName +
        " under these switches\n");
}

process.stdout.write("build-ab: done\n");
