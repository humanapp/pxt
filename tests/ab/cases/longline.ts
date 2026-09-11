// Capture case: longline -- a single very long line plus a high-volume burst,
// to check the capture channel for length and buffering limits.
console.log("HWAB START longline")
let s = ""
for (let i = 0; i < 400; i++) s = s + "0123456789"
console.log("LONG len=" + s.length)
console.log(s)
for (let i = 0; i < 500; i++) console.log("BURST " + i)
console.log("HWAB PASS longline")
