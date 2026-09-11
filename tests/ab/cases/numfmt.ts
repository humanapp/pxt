// Capture case: numfmt -- what the number model and the output channel do to
// values a bit-pattern renderer cares about.
//
// The non-ASCII probe at the end is built with String.fromCharCode: this file
// stays ASCII while the captured bytes do not. U+00E9 is two UTF-8 bytes and
// U+4E2D is three, which is what tells a UTF-8 capture from a latin1 one.
const HEXD2 = "0123456789abcdef"
function h2(v: number): string {
    return HEXD2.charAt((v >> 4) & 0xf) + HEXD2.charAt(v & 0xf)
}
function bits(x: number): string {
    const b = Buffer.create(8)
    b.setNumber(NumberFormat.Float64LE, 0, x)
    let s = ""
    for (let i = 7; i >= 0; i--) s += h2(b.getNumber(NumberFormat.UInt8LE, i))
    return s
}
function show(label: string, x: number) {
    console.log("N " + label + " dec=" + x + " bits=" + bits(x))
}

console.log("HWAB START numfmt")
show("zero", 0)
show("negzero", -0)
show("one", 1)
show("tenth", 0.1)
show("sum", 0.1 + 0.2)
show("nan", 0 / 0)
show("inf", 1 / 0)
show("neginf", -1 / 0)
show("2p31", 2147483648)
show("2p32", 4294967296)
show("2p53", 9007199254740992)
show("2p53p1", 9007199254740993)
show("maxsafe", 9007199254740991)
show("tiny", 5e-324)
show("big", 1.7976931348623157e308)
console.log("OPS " + (7 % 3) + " " + (-7 % 3) + " " + (7 % -3))
console.log("DIV " + (7 / 2) + " " + (-7 / 2) + " " + Math.idiv(7, 2) + " " + Math.idiv(-7, 2))
console.log("BITS " + (1 << 31) + " " + ((1 << 31) >>> 0) + " " + (~0) + " " + (~0 >>> 0))
console.log("TRUNC " + (2147483648 | 0) + " " + (4294967296 | 0) + " " + (1e10 | 0))
console.log("ROUND " + Math.round(0.5) + " " + Math.round(-0.5) + " " + Math.round(2.5))
console.log("FLOOR " + Math.floor(-0.5) + " " + Math.trunc(-1.5) + " " + Math.ceil(-1.5))
console.log("STR " + (255).toString() + " " + (0.1).toString() + " " + (1e300).toString())
console.log("CHR " + String.fromCharCode(65) + String.fromCharCode(9) + String.fromCharCode(126) + " code=" + "A".charCodeAt(0))
const NONASCII = String.fromCharCode(0xe9) + String.fromCharCode(0x4e2d)
console.log("NONASCII " + NONASCII + " len=" + NONASCII.length + " c0=" + NONASCII.charCodeAt(0) + " c1=" + NONASCII.charCodeAt(1))
console.log("EMPTY [" + "" + "]")
console.log("HWAB PASS numfmt")
