// Capture case: throwing -- an uncaught throw. The program dies partway
// through, which is a program failure (exit 1), not a harness problem.
console.log("HWAB START throwing")
console.log("before the throw")
throw "deliberate"
