/** Keep only native graphics diagnostics from verbose web-ext, never raw debug output. */
export function nativeGraphicsDiagnostic(line) {
  const message = String(line).match(/Firefox (?:stderr|stdout):\s*(.*)/)?.[1];
  if (
    !message ||
    !/\b(?:GFX\d*|WebGL|EGL|GLX|Mesa|llvmpipe|pthread)\b|out of memory/i.test(message) ||
    /authorization|cookie|password|fixture-user|\bBasic\s|\bBearer\s/i.test(message)
  )
    return null;
  return message
    .replace(/moz-extension:\/\/[a-z0-9-]+/gi, "moz-extension://<extension>")
    .slice(0, 1000);
}
