// Talks to the page through ops.js. Tests replace it with window.opfsTransport.
const transport = window.opfsTransport || extensionTransport();

function extensionTransport() {
  const api = globalThis.browser || globalThis.chrome;
  const tabId = api.devtools
    ? api.devtools.inspectedWindow.tabId
    : Number(new URLSearchParams(location.search).get('tabId'));
  let port = null;
  let nextId = 1;
  const waiting = new Map();
  function connect() {
    port = api.runtime.connect({ name: 'opfs-inspector' });
    port.onMessage.addListener((reply) => {
      const resolve = waiting.get(reply.id);
      waiting.delete(reply.id);
      if (resolve) resolve(reply);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const resolve of waiting.values()) resolve({ ok: false, error: 'The extension restarted. Try again.' });
      waiting.clear();
    });
  }
  return {
    call(op, args) {
      if (!port) connect();
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        port.postMessage({ id, tabId, op, args });
      });
    },
    onNavigated(listener) {
      if (api.devtools) api.devtools.network.onNavigated.addListener(listener);
    },
  };
}

// Resolves to the op's value, or throws Error(message).
export async function call(op, args) {
  const reply = await transport.call(op, args);
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'No answer from the page.');
  return reply.value;
}

export function onNavigated(listener) {
  if (transport.onNavigated) transport.onNavigated(listener);
}
