# tests/ab: A/B capture and comparison

An A/B run compares two **legs**. A leg is three things: the **backend** that
runs the program (`hw` flashes a board and reads its serial device; `sim` runs
the compiled JS headlessly in node), the **target** checkout the program is
built in, and the **snapshot** -- which compiler built it. Two legs that differ
in exactly one of the three answer a question about that one thing: same target
and same backend, two compilers, is a codegen A/B; same compiler and same
target, two backends, asks whether the simulator and the device agree. A leg
whose capture already exists as a file is the degenerate case, and it is how a
capture is compared against a golden stream committed to the repo.

Only the capture stage is bound to the backend. Generation, build and diff are
shared, so adding a backend does not touch them.

    npm run ab -- verify --suite capture --backend sim --target ../pxt-arcade
    npm run ab -- build --v2-only --ref-switches "<optOutSwitch,...>"
    npm run ab -- ab truthiness --backend hw
    npm run ab -- ab hello --suite capture --candidate sim --reference file:golden/hello.log

`node tests/ab/ab.js <command>` is the same thing and works from anywhere. The
hardware spelling of the workflow is `tests/hw-ab/hwab.js` (`npm run hwab`),
which is this with `--backend hw` filled in.

The lang-test0 codegen cases run on either backend, which is how a simulator
result and a device result are compared:

    # simulator leg -- no board needed
    npm run ab -- verify --suite langtest --backend sim --target ../pxt-microbit

    # hardware leg -- needs a micro:bit on USB and built hexes
    npm run hwab -- build --candidate-only --v2-only
    npm run ab -- capture conditiontruthiness candidate --backend hw \
        --suite langtest --out tests/hw-ab/out

## Two layers

**Layer 1 is `lib/`, and it knows nothing about diffing.** It is a plain
library; a consumer that is not an A/B comparison calls it directly. `verify`
is exactly that consumer -- it runs each case N times, checks the captures are
byte-identical, checks each run ended with the exit code its case expects, and
compares the same case across targets, without diffing anything.

| module | what it owns |
| --- | --- |
| `lib/capture.js` | the capture data model and the substrate that produces one |
| `lib/cases.js` | what runs, where its project goes, how it is built -- all the target knowledge |
| `lib/verdict.js` | determinism, cross-leg comparison, exit-code expectations |

**Layer 2 is `ab.js`, `build-ab.js` and `diff-ab.js`**: the A/B orchestrator,
the two-sided build, and the normalizing diff. One consumer of layer 1 among
others.

### Layer 1 API surface

`capture.js` -- a capture is a **set of named streams**. `serial` is the only
stream today, and it is always addressed by name: no function is called "the
serial log" and no shape has a serial field, so a backend that also records a
second stream is added by extending `STREAMS`.

    MARKER                              the verdict token the programs print ("HWAB")
    EXIT                                {PASS:0, FAIL:1, TIMEOUT:2, SETUP:3}
    STREAMS, streamIds(), stream(id)    the stream registry
    BACKENDS, backendIds(), backend(id) the backend registry
    create({dir, name, streams})        a capture handle
    fromFile(path, streamId)            a capture that already exists on disk
    streamPath(c, streamId)             where one stream of it lives
    hasStream / readStream / streamBytes / hashStream
    run({backend, source, capture, stream, expect, timeout, marker, runtime, extra})
                                        run one backend once; returns its exit code

`cases.js` -- suites, generation, and building.

    SUITES, suiteIds(), suite(id)       the suite registry
    ARTIFACTS, artifact(id), artifactPath(projectDir, id)
    targetInfo(dir)                     {dir, id, corepkg, version} from pxtarget.json
    runtimeDirs(target)                 where the shared runtime layers live
    generate({target, suite, log})      write the projects, record cases.txt
    enumerate({target, suite})          the case list
    caseInfo(suite, name)               {exit, timeout, stable, verdict, verify}
    projectDir(target, suite, name), casesFile(target, suite)
    build({projectDir, artifact, pxtCli, switches, logPath})

`verdict.js` -- three content-blind questions, each taking the stream by name.

    determinism({captures, stream})     N captures agree, reported as one sha256
    compare({a, b, stream})             two captures agree
    exitCode({actual, expected})        a run ended the way its case says
    describe(v)                         one line for a report

A byte comparison cannot be argued with and needs no normalization rules. The
line-aware, normalizing comparison lives in `diff-ab.js`, which is where
tolerating legitimate variation belongs.

## Contents

| file | what it does |
| --- | --- |
| `ab.js` | one entry point: `gen`, `build`, `capture`, `diff`, `ab`, `verify`, `cases` |
| `lib/capture.js`, `lib/cases.js`, `lib/verdict.js` | layer 1 |
| `backends/hw.js` | flash an attached micro:bit, read its USB-CDC serial device |
| `backends/sim.js` | run the compiled JS on the pxt sim runtime, in this node process |
| `build-ab.js` | build candidate and reference artifacts into `out/` |
| `diff-ab.js` | normalize and diff two captured streams |
| `cases/*.ts` | the capture suite's programs, one file per case |

`out/` is generated and gitignored. Both backends still introduce their own
messages as `run-capture:` and `run-capture-sim:`; that is the prefix hw-ab
users have always seen and it is unchanged.

## Case suites

| suite | programs | projects | artifact |
| --- | --- | --- | --- |
| `langtest` (default) | the codegen corpus files from `tests/compile-test/lang-test0` named in the `LANG_CASES` table, plus a `soak` program | `<target>/projects/hw-ab/` | hex |
| `capture` | `cases/*.ts` -- plain lines and whitespace, a very long line and a 500-line burst, number formatting and IEEE-754 bit patterns, and the three ways a run can end | `<target>/projects/ab-capture/` | js |

To add a langtest case, add one entry to `LANG_CASES` in `lib/cases.js`. To add
a capture case, add a `.ts` file to `cases/`. Everything downstream reads the
generated `cases.txt`, so nothing else needs editing. A case that does not end
in a plain pass says so in the `EXPECT` table.

`lib/cases.js` is the only file that knows anything about a target: which
package supplies the core APIs (`corepkg`), which target id to stamp, and where
a project has to sit for the CLI to find the target at all. The capture stage
downstream is target-blind, which is what makes a capture of one program on two
different targets comparable byte for byte.

## Commands

Artifact paths are derived, so only the case name is ever typed: case `C` on
side `S` is `<out>/<C>/<S>.{hex,js,log}`. A case may be named exactly or by any
unique substring of it.

| command | what it does |
| --- | --- |
| `gen` | write the suite's projects into the target |
| `build [args...]` | build both sides; arguments pass through to `build-ab.js` |
| `capture <case> [side]` | run one built artifact and capture its streams |
| `diff <case>` | diff the case's candidate and reference streams |
| `ab <case>` | capture both legs, then diff |
| `verify` | N-run determinism, expected exit codes, cross-target comparison |
| `cases` | list the suite's cases and what exists now |

Common options: `--backend hw|sim`, `--suite <id>`, `--target <dir>`,
`--out <dir>`, `--timeout <sec>`. `ab` takes `--candidate <leg>` and
`--reference <leg>`, where a leg is `<backend>`, `<backend>@<target-dir>`, or
`file:<path>`. `verify` takes repeated `--target`, `--runs <n>`,
`--case <name>`, `--no-build` and `--pxt <pxt.js>`; `--pxt target` builds each
target with the CLI inside its own checkout, which is one pinned snapshot per
leg.

Exit codes are the invoked script's, verbatim; `ab` reports the first failing
stage's, `verify` exits 1 if any verdict failed.

## Backends

Both take the built artifact and the stream file positionally, accept
`--timeout` and `--expect`, and report the same exit codes:

    exit 0  <marker> PASS seen
    exit 1  ASSERT seen, or the program faulted
    exit 2  timeout with neither
    exit 3  the harness could not run anything at all

Exit 3 is reserved for the last of those, so a CI gate can tell a broken
checkout from a broken program.

Verdicts are read only from the program's own `HWAB START` banner onward, and
`--expect <case>` additionally requires the banner and the verdict to name that
case. On hardware this is load-bearing: DAPLink buffers serial while no host is
reading, so the first bytes after the port opens can belong to the previously
flashed program -- including its PASS banner. Both backends stop at the first
verdict line, so a program that keeps printing afterwards (the generated PASS
heartbeat repeats for a minute) does not have where the clock fell decide how
many bytes the capture holds.

`HWAB` is the marker token the generated programs print and `diff-ab.js`
recognizes. `backends/sim.js` takes `--marker` for a program that prints
another one; `backends/hw.js` does not.

**sim.** `--pxt-core <dir>` and `--common-packages <dir>` name the checkouts the
two runtime layers are loaded from; without them the backend walks up from the
artifact to find them, which works while the artifact is still inside the
project. `--sim <file.js>` loads an extra simulator bundle and may be repeated.
The board is manufactured: pxsim's bare board carries no per-feature state
object, so any missing `<feature>State` is built on first read from the matching
class in `common-sim.js` (with a 16-entry palette, which is what makes the
screen state report 4bpp). Serial writes are taken at `BaseBoard.writeSerial`,
ahead of the debounced `bulkserial` message that would otherwise drop the tail
of a short run, and are written as UTF-8.

**hw.** `--soak <minutes>` captures for a duration and then checks whether
`HWAB SOAK` lines were still arriving at the end (exit 0 still printing, 1
stalled). A timeout with no banner at all means the program never ran -- usually
a flash DAPLink rejected -- so the whole flash and capture is retried once.

## Known boundaries

- **Soak and GC behaviour are invisible to the sim backend by construction.**
  The soak program's numbers come from the device collector (`control.gc()` /
  `control.gcStats()`); there is no equivalent heap under the sim, so a leak
  that shows up as a falling `free=` on hardware has nothing to show up in.
  Soak is a hardware-only procedure.
- **Sim and device decimal rendering differ.** Compare float values by their
  bit patterns, never by their decimal strings -- the `trace` and `numfmt`
  cases print `bits=` for exactly this reason. A case that prints a bare
  `0.1 + 0.2` is a case that cannot be compared across backends.
- **The sim backend assumes `pxt-common-packages` keeps shipping
  `built/common-sim.js` in its npm `files` list.** If that ever stops being
  true the backend loses the real namespace implementations and programs fail
  during startup. The fallback is `buildCommonSimAsync`, which is much heavier
  (it builds the bundle); it is noted here rather than wired in.
- **The sim artifact is built with `pxt build --js`, falling back to
  `--debug`.** Both are JS-only builds -- no native image, no run, no deploy --
  and `--debug` additionally emits breakpoint instrumentation. A target checkout
  pinned to a tag older than the `--js` flag carries a CLI that rejects it by
  name, so `lib/cases.js` tries `--js` first and retries once with `--debug`
  when the CLI says `Unrecognized flag`. The captured output of the two is
  byte-identical (measured, on the same case through both builds), so which one
  produced the artifact does not matter to anything downstream. Recognising the
  rejection needs the build log, so a caller that takes the build output itself
  instead of passing `logPath` gets no retry.
- **`--soak` belongs to the hw backend.** The sim backend has no soak mode, and
  `verify` skips the soak case: a plain capture of a program that prints no
  verdict can only time out.

## Platforms

Only `backends/hw.js` touches hardware; it detects the platform itself.
Everything else is platform-independent node.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| MICROBIT volume | `/Volumes/MICROBIT` | `/media/$USER/MICROBIT`, `/run/media/$USER/MICROBIT`, `/media/MICROBIT` | the drive letter whose volume label is `MICROBIT`, from `Get-CimInstance Win32_LogicalDisk` |
| serial device | `/dev/cu.usbmodem*` | `/dev/ttyACM*` | the `COM` port whose name matches mbed/DAPLink/USB Serial, from `Get-CimInstance Win32_SerialPort`; opened as `\\.\COM<n>` |
| line settings | `stty -f <dev> 115200 raw -echo` | `stty -F <dev> 115200 raw -echo` | `mode COM<n>: BAUD=115200 PARITY=n DATA=8 STOP=1 to=off xon=off dtr=on rts=on` |

`MICROBIT_VOLUME` (path or drive of the mounted drive, e.g. `/Volumes/MICROBIT`
or `E:`) and `MICROBIT_SERIAL` (serial device to read, e.g. `/dev/ttyACM0` or
`COM5`) override the discovery. Both accept exactly what the platform's own
tools print.

Ordering differs by platform and matters. On POSIX the device is opened first
and the settings are applied second: terminal settings reset when the last open
of a tty closes, and `stty` opens and closes the device itself, so the held fd
is what makes 115200/raw survive to the reader. On Windows the configuration
belongs to the port rather than to a handle, so `mode` runs before the handle is
opened. `dtr=on` is not optional there -- a CDC device may transmit nothing
until DTR is asserted.

Linux permissions: opening `/dev/ttyACM*` usually requires membership in the
`dialout` group (`sudo usermod -a -G dialout $USER`, then log in again).

The hardware troubleshooting guide -- panic numbers, DAPLink failures, soak
procedure, Windows notes -- is in `tests/hw-ab/README.md`.
