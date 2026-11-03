// Adds the panel to the browser's developer tools.
(globalThis.browser || globalThis.chrome).devtools.panels.create('OPFS Inspector', 'icons/icon-32.png', 'panel.html');
