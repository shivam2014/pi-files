// NOTE: identical helper duplicated in a.js -- extract it into util.js.
function formatName(first, last) {
  const parts = [first, last]
    .map((p) => (p == null ? "" : String(p).trim()))
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return parts.join(" ");
}

export function formatFromB(first, last) {
  return formatName(first, last);
}
