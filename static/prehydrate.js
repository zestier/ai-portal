// Pre-hydration bootstrap. Runs before SvelteKit hydrates so the first
// paint matches the user's persisted sidebar state and resolved theme,
// avoiding a flash on load.
//
// Kept as an external static script (not inline in app.html) so the CSP
// can drop `script-src 'unsafe-inline'`. Any inline replacement must
// move here, or pick up SvelteKit's hash-based CSP integration.
(function () {
  try {
    var v = localStorage.getItem("sidebarOpen");
    var open =
      v === "true"
        ? true
        : v === "false"
          ? false
          : window.matchMedia("(min-width: 769px)").matches;
    document.documentElement.dataset.sidebar = open ? "open" : "closed";
  } catch {
    document.documentElement.dataset.sidebar = "open";
  }
})();
// When the user's theme preference is "system", resolve data-theme from
// prefers-color-scheme before first paint, and keep it in sync if the OS
// theme changes while the tab is open. For explicit "dark"/"light" the
// server already rendered the correct value.
(function () {
  try {
    var root = document.documentElement;
    if (root.dataset.themeMode !== "system") return;
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    function apply() {
      if (root.dataset.themeMode === "system") {
        root.dataset.theme = mq.matches ? "light" : "dark";
      }
    }
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
    else if (mq.addListener) mq.addListener(apply);
  } catch {
    /* no-op */
  }
})();
