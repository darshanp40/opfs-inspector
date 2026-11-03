// Lets the panel call ops.js directly when it runs as a normal page in tests.
window.opfsTransport = {
  call: (op, args) => globalThis.__opfsInspector.run(op, args),
};
