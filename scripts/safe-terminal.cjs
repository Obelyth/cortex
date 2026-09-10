/** Make one untrusted value incapable of changing terminal lines or terminal state. */
function safeLogValue(value) {
  const text = String(value);
  let safe = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      const csi = code === 0x9b || text.charCodeAt(i + 1) === 0x5b;
      if (code === 0x1b) i++;
      if (csi) {
        while (i + 1 < text.length) {
          const next = text.charCodeAt(i + 1);
          i++;
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (i < text.length && text.charCodeAt(i) === 0x5d) {
        while (i + 1 < text.length) {
          const next = text.charCodeAt(i + 1);
          i++;
          if (next === 0x07 || (next === 0x5c && text.charCodeAt(i - 1) === 0x1b)) break;
        }
      }
      continue;
    }
    if (code === 0x0d) safe += "\\r";
    else if (code === 0x0a) safe += "\\n";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) safe += `\\x${code.toString(16).padStart(2, "0")}`;
    else safe += text[i];
  }
  return safe;
}

module.exports = { safeLogValue };
