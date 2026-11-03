// The command registry. Shortcuts, toolbar buttons, menus and the help list all read it.
import { state, fail } from './state.js';

const commands = [];

// Cmd on macOS, Ctrl elsewhere.
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || '');

// "Mod+Shift+F" -> its parts. A key that is "+" itself ends the string.
const split = (keys) => (keys.endsWith('+') ? [...keys.slice(0, -1).split('+').filter(Boolean), '+'] : keys.split('+'));

const parse = (keys) => {
  const parts = split(keys);
  const key = parts.pop();
  return { mod: parts.includes('Mod'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), key };
};

// {id, label, tip, keys, when, run, scope, typing, swallow, toolbar, menu}
// keys: one string, or an array (the first is the one shown).
// when(state) -> boolean enables the command.
// scope: 'tree', 'editor', 'preview', 'query' or '!editor' limits the keys to where focus is.
// typing: the keys also work while a text field has focus.
// swallow: the keys are taken even when the command is disabled.
export function register(command) {
  const keys = [].concat(command.keys || []);
  commands.push({ ...command, keys, parsed: keys.map(parse) });
}

// 'all', or the name of a flag such as 'toolbar' or 'menu'.
export const commandsFor = (context) => commands.filter((c) => context === 'all' || c[context]);

export const isEnabled = (command) => !command.when || command.when(state);

const MAC_NAMES = { Left: '←', Right: '→', Backspace: '⌫', Delete: '⌦', Enter: '↵' };
const MAC_MODS = { Mod: '⌘', Shift: '⇧', Alt: '⌥' };

export function shortcutLabel(keys) {
  const mac = isMac();
  const parts = split(keys).map((p) => {
    if (mac) return MAC_MODS[p] || MAC_NAMES[p] || p.toUpperCase();
    return p === 'Mod' ? 'Ctrl' : p.length === 1 ? p.toUpperCase() : p;
  });
  return parts.join(mac ? '' : '+');
}

export const hintFor = (command) => (command.keys.length ? shortcutLabel(command.keys[0]) : '');

export function runCommand(command) {
  return Promise.resolve(command.run()).catch(fail);
}

const NAMED = { Left: 'ArrowLeft', Right: 'ArrowRight' };

function matches(k, event) {
  const mac = isMac();
  if (mac ? event.ctrlKey : event.metaKey) return false;
  if (k.mod !== (mac ? event.metaKey : event.ctrlKey) || k.alt !== event.altKey) return false;
  // "?" and "+" need Shift on most keyboards, so Shift is not compared for them.
  if (k.key !== '?' && k.key !== '+' && k.shift !== event.shiftKey) return false;
  // Alt changes event.key on macOS to a non-letter, so only then match by physical key.
  if (/^[a-z]$/i.test(k.key)) {
    if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === k.key.toLowerCase();
    return event.code === `Key${k.key.toUpperCase()}`;
  }
  return event.key === (NAMED[k.key] || k.key);
}

const inScope = (scope) => {
  const active = document.activeElement;
  const inEditor = !!active && active.closest('.cm-editor') !== null;
  if (scope === 'tree') return !!active && active.closest('#tree') !== null;
  if (scope === 'editor') return inEditor;
  if (scope === 'preview') return !!active && active.closest('.image-view') !== null;
  if (scope === 'query') return !!active && active.closest('.query-editor') !== null;
  if (scope === '!editor') return !inEditor;
  return true;
};

// Runs before the tree's own keys, so a command wins when it applies.
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || event.target.closest('.menu, dialog')) return;
  const typing = event.target.closest('input, textarea, select, [contenteditable]') !== null;
  for (const command of commands) {
    if (typing && !command.typing) continue;
    if (!command.parsed.some((k) => matches(k, event)) || !inScope(command.scope)) continue;
    if (!isEnabled(command) && !command.swallow) continue;
    event.preventDefault();
    event.stopPropagation();
    if (isEnabled(command)) runCommand(command);
    return;
  }
}, true);

// Gives each toolbar button its name, tooltip and click from its command.
export function bindToolbar() {
  for (const command of commandsFor('toolbar')) {
    const button = document.getElementById(command.id);
    const hint = hintFor(command);
    button.setAttribute('aria-label', command.label);
    button.dataset.tip = hint ? `${command.tip} (${hint})` : command.tip;
    button.addEventListener('click', () => runCommand(command));
  }
}

export function syncToolbar() {
  for (const command of commandsFor('toolbar')) {
    document.getElementById(command.id).disabled = !isEnabled(command);
  }
}
