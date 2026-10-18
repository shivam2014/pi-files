// dedupe(arr): remove duplicate primitive values, keeping the first occurrence.
// This implementation is O(n^2). Make it O(n) on average without changing behaviour.
export function dedupe(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (out.indexOf(arr[i]) === -1) {
      out.push(arr[i]);
    }
  }
  return out;
}
