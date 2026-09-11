// Capture case: failing -- exercises the assert exit path (exit 1).
function assert(cond: boolean, id: string) {
    if (!cond) {
        console.log("ASSERT " + id)
    }
}
console.log("HWAB START failing")
console.log("before")
assert(1 + 1 == 3, "failing:arith")
console.log("HWAB PASS failing")
