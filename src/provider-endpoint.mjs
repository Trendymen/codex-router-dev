// Provider URLs are base URLs, not origins: Qwen Plan deliberately exposes
// its OpenAI-compatible surface below /compatible-mode/v1.  URL(path, base)
// would drop that path when the base does not end in a slash, so normalize the
// base first and append exactly one leaf instead.
export function providerEndpoint(baseUrl, leaf) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new TypeError("provider base URL must be a non-empty string");
  }
  if (typeof leaf !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(leaf.replace(/^\/+/, ""))) {
    throw new TypeError("provider endpoint leaf must be one relative path segment");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:|[\\?#]|^\/\/|\.{1,2}(?:\/|$)/.test(leaf)) {
    throw new TypeError("provider endpoint leaf must be a relative path segment");
  }
  const base = `${baseUrl.replace(/\/+$/, "")}/`;
  return new URL(leaf.replace(/^\/+/, ""), base);
}
