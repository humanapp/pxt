// Capture case: trace -- hex-literal data, a looped schedule, and IEEE-754 bit
// patterns printed as hex, to check number and string fidelity through the
// capture channel.

const HEXD = "0123456789abcdef"

function hex2(v: number): string {
    return HEXD.charAt((v >> 4) & 0xf) + HEXD.charAt(v & 0xf)
}

function bufHex(b: Buffer): string {
    let s = ""
    for (let i = 0; i < b.length; i++) s += hex2(b.getNumber(NumberFormat.UInt8LE, i))
    return s
}

// The bit pattern of a double, most significant byte first.
function bits64(x: number): string {
    const b = Buffer.create(8)
    b.setNumber(NumberFormat.Float64LE, 0, x)
    let s = ""
    for (let i = 7; i >= 0; i--) s += hex2(b.getNumber(NumberFormat.UInt8LE, i))
    return s
}

function assert(cond: boolean, id: string) {
    if (!cond) {
        console.log("ASSERT " + id)
    }
}

const DATA = hex`00010203fffefdfc7f80c0de`
const SCHEDULE = [0, 1, 2, 3, 5, 8, 13]
const VALUES = [0, 1, -1, 0.5, -0.5, 0.1, 3.141592653589793, 1e300, -0]

console.log("HWAB START trace")
console.log("data len=" + DATA.length + " hex=" + bufHex(DATA))
assert(DATA.length == 12, "trace:datalen")
assert(bufHex(DATA) == "00010203fffefdfc7f80c0de", "trace:datahex")

for (let i = 0; i < SCHEDULE.length; i++) {
    const step = SCHEDULE[i]
    const v = VALUES[step % VALUES.length]
    console.log("TRACE step=" + step + " i=" + i + " v=" + v + " bits=" + bits64(v))
}

for (let i = 0; i < VALUES.length; i++) {
    console.log("VALUE " + i + " dec=" + VALUES[i] + " bits=" + bits64(VALUES[i]))
}

// Integer formatting through string concatenation.
console.log("INT " + 0 + " " + 1 + " " + (-1) + " " + 255 + " " + 65535 + " " + 2147483647 + " " + (-2147483648))
console.log("BIG " + 1073741824 + " " + 4294967295 + " " + 9007199254740991)
console.log("SHIFT " + (1 << 30) + " " + ((1 << 31) >> 0) + " " + (255 >>> 0))

assert(bits64(1) == "3ff0000000000000", "trace:bits1")
assert(bits64(0.5) == "3fe0000000000000", "trace:bitshalf")
// Static TypeScript folds -0 into the integer 0, so the sign bit is gone by
// the time the value reaches the buffer. Standard TypeScript gives
// 8000000000000000 here.
assert(bits64(-0) == "0000000000000000", "trace:bitsnegzero")

console.log("HWAB PASS trace")
