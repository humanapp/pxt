// Capture case: hanging -- never reaches a verdict, exercises the timeout path
// (exit 2).
console.log("HWAB START hanging")
let n = 0
while (true) {
    n++
    if (n % 100000000 == 0) console.log("still going " + n)
}
