// Runs in the inspected page after ops.js, only once the panel asks for it.
// It answers requests from the extension and holds nothing between them.
(() => {
  const api = globalThis.browser || globalThis.chrome;
  if (globalThis.__opfsInspectorAgent) return;
  globalThis.__opfsInspectorAgent = true;

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'opfs-inspector') return false;
    globalThis.__opfsInspector.run(message.op, message.args).then(sendResponse);
    return true;
  });
})();
