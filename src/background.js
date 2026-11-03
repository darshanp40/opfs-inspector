// Passes requests from the panel to the inspected tab, adding the agent to the
// tab the first time it is needed after each page load.
const api = globalThis.browser || globalThis.chrome;

async function inject(tabId) {
  await api.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['src/ops.js', 'src/agent.js'],
  });
}

async function send(tabId, op, args) {
  const message = { type: 'opfs-inspector', op, args };
  try {
    const reply = await api.tabs.sendMessage(tabId, message, { frameId: 0 });
    if (reply) return reply;
  } catch {
    // No agent in this page yet.
  }
  await inject(tabId);
  return api.tabs.sendMessage(tabId, message, { frameId: 0 });
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'opfs-inspector') return;
  port.onMessage.addListener(async ({ id, tabId, op, args }) => {
    let reply;
    try {
      reply = await send(tabId, op, args);
    } catch (error) {
      reply = { ok: false, error: `Cannot reach the page: ${error.message}. Pages such as the browser's own settings cannot be inspected.` };
    }
    try {
      port.postMessage({ id, ...(reply || { ok: false, error: 'The page did not answer.' }) });
    } catch {
      // The panel was closed.
    }
  });
});
