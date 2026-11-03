// The right-click menu and the shortcut help.
import { focusTree } from './state.js';
import { commandsFor, hintFor, isEnabled, runCommand } from './commands.js';

let open = null; // { menu, stop }

export function closeMenu() {
  if (!open) return;
  const { menu, stop } = open;
  open = null;
  stop();
  menu.remove();
}

// Opens a menu at the pointer. Closing it puts focus back on the tree.
export function openMenu(x, y, list) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions');
  const items = list.map((command) => {
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    if (!isEnabled(command)) item.setAttribute('aria-disabled', 'true');
    const label = document.createElement('span');
    label.textContent = command.label;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = hintFor(command);
    item.append(label, hint);
    item.addEventListener('click', () => pick(command));
    return item;
  });
  menu.append(...items);
  const enabled = () => items.filter((i) => i.getAttribute('aria-disabled') !== 'true');
  const pick = (command) => {
    closeMenu();
    focusTree();
    if (isEnabled(command)) runCommand(command);
  };
  menu.addEventListener('keydown', (event) => {
    const live = enabled();
    const i = live.indexOf(document.activeElement);
    const to = {
      ArrowDown: live[(i + 1) % live.length],
      ArrowUp: live[(i <= 0 ? live.length : i) - 1],
      Home: live[0],
      End: live[live.length - 1],
    }[event.key];
    if (to) to.focus();
    else if (event.key === 'Enter' || event.key === ' ') items[items.indexOf(document.activeElement)]?.click();
    else if (event.key === 'Escape' || event.key === 'Tab') {
      closeMenu();
      focusTree();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  const outside = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', closeMenu, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  open = {
    menu,
    stop: () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    },
  };
  document.body.append(menu);
  // Keep the whole menu in view.
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`;
  const first = enabled()[0];
  if (first) first.focus();
}

// Lists every registered command with its keys.
export function openHelp() {
  const dialog = document.getElementById('help');
  dialog.querySelector('tbody').replaceChildren(...commandsFor('all').map((command) => {
    const row = document.createElement('tr');
    row.setAttribute('role', 'row');
    const name = document.createElement('td');
    name.textContent = command.label;
    const keys = document.createElement('td');
    keys.className = 'keys';
    keys.textContent = command.keys.map((k) => hintFor({ keys: [k] })).join(', ');
    row.append(name, keys);
    return row;
  }));
  dialog.showModal();
}
