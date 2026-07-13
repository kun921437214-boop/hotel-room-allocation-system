/**
 * @param {any} root
 * @param {() => any} factory
 */
(function exposeHtmlUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) /** @type {any} */ (root).HtmlUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createHtmlUtils() {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  return { escapeHtml };
});
