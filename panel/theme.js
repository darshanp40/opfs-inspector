// Follows the DevTools theme, or the system theme outside DevTools.
const api = globalThis.browser || globalThis.chrome;
const panels = api && api.devtools && api.devtools.panels;
const dark = matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const name = panels && panels.themeName;
  const isDark = name ? name === 'dark' : dark.matches;
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
}

// Firefox tells the panel when the DevTools theme changes.
if (panels && panels.onThemeChanged) panels.onThemeChanged.addListener(applyTheme);
dark.addEventListener('change', applyTheme);
