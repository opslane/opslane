process.on('SIGTERM', () => {});
process.once('message', () => {
  setInterval(() => {}, 1_000);
});

