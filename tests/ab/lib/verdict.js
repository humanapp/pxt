/*
 * Verdicts over captures: the questions that can be asked of captured streams
 * without interpreting a single line of their content.
 *
 * Three of them, and they compose:
 *
 *   determinism   N captures of the same program on the same backend are
 *                 byte-identical (reported as one sha256)
 *   compare       two captures from different legs are byte-identical
 *   exitCode      a run reported the exit code its case says it should
 *
 * All three are content-blind on purpose. A byte comparison cannot be argued
 * with, needs no normalization rules, and does not go stale when a case starts
 * printing something new. The normalizing, line-aware comparison lives one
 * layer up in diff-ab.js, which is where tolerating legitimate variation
 * belongs -- these are the hard floor beneath it.
 *
 * Every function takes the stream to look at by name, and none of them knows
 * what an A/B leg is.
 */

"use strict";

const capture = require("./capture");

function hashes(captures, streamId) {
    return captures.map(c => ({
        name: c.name,
        path: capture.streamPath(c, streamId),
        sha256: capture.hashStream(c, streamId),
        bytes: capture.streamBytes(c, streamId)
    }));
}

// N runs of one program on one backend agree byte for byte. With fewer than two
// captures there is nothing to disagree, which is reported as ok with the one
// hash rather than as a special case -- a caller running once still gets the
// hash it wanted.
function determinism(opts) {
    if (!opts || !opts.captures || !opts.captures.length)
        throw new Error("verdict: determinism needs { captures }");
    const streamId = opts.stream || capture.defaultStream();
    const hs = hashes(opts.captures, streamId);
    const first = hs[0].sha256;
    const ok = hs.every(h => h.sha256 === first);
    return {
        kind: "determinism",
        stream: streamId,
        ok: ok,
        runs: hs.length,
        sha256: ok ? first : "",
        hashes: hs,
        bytes: hs[0].bytes
    };
}

// Two captures carry the same bytes on the named stream. The two may come from
// different backends, different targets, different days or a file committed to
// the repo -- this asks nothing about where they came from.
function compare(opts) {
    if (!opts || !opts.a || !opts.b)
        throw new Error("verdict: compare needs { a, b }");
    const streamId = opts.stream || capture.defaultStream();
    const a = hashes([opts.a], streamId)[0];
    const b = hashes([opts.b], streamId)[0];
    return {
        kind: "compare",
        stream: streamId,
        ok: a.sha256 === b.sha256,
        a: a,
        b: b
    };
}

// A run ended the way its case says it should. `expected` is a number or a list
// of acceptable codes -- a case that may legitimately end two ways says so
// rather than being checked loosely.
function exitCode(opts) {
    if (!opts || opts.actual === undefined || opts.expected === undefined)
        throw new Error("verdict: exitCode needs { actual, expected }");
    const wanted = Array.isArray(opts.expected) ? opts.expected : [opts.expected];
    return {
        kind: "exitCode",
        ok: wanted.indexOf(opts.actual) >= 0,
        actual: opts.actual,
        expected: wanted,
        actualName: capture.exitName(opts.actual),
        expectedNames: wanted.map(capture.exitName)
    };
}

// One line per verdict, for a report a human reads. Shaped so that a column of
// them lines up: verdict first, then the evidence.
function describe(v) {
    if (v.kind === "determinism")
        return v.ok
            ? v.runs + " run(s) byte-identical  sha256=" + v.sha256 +
              "  " + v.bytes + " byte(s)"
            : "DIVERGED across " + v.runs + " run(s): " +
              v.hashes.map(h => h.sha256.slice(0, 12)).join(" ");
    if (v.kind === "compare")
        return v.ok
            ? "byte-identical  sha256=" + v.a.sha256
            : "DIFFER  a=" + v.a.sha256.slice(0, 12) + " (" + v.a.bytes + "B)" +
              "  b=" + v.b.sha256.slice(0, 12) + " (" + v.b.bytes + "B)";
    if (v.kind === "exitCode")
        return (v.ok ? "exit " : "WRONG EXIT ") + v.actual +
            " (" + v.actualName + "), expected " + v.expected.join(" or ");
    return JSON.stringify(v);
}

function allOk(verdicts) {
    return verdicts.every(v => v.ok);
}

module.exports = {
    determinism: determinism,
    compare: compare,
    exitCode: exitCode,
    describe: describe,
    allOk: allOk
};
