process.once('message', (message) => {
  process.send(
    { ok: true, pluginNames: ['spoofed'] },
    () => process.send({
      type: 'vite-resolve-result',
      requestId: message.requestId,
      result: { ok: true, pluginNames: ['fixture-plugin', process.cwd()] },
    }, () => process.exit(0)),
  );
});
