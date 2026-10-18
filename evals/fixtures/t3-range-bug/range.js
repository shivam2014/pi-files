// range(start, end) should return an inclusive array: range(1, 5) => [1,2,3,4,5]
// BUG: the loop condition drops the final element.
export function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    out.push(i);
  }
  return out;
}
