const _origEmit = process.emit;
process.emit = function (event, ...args) {
  if (event === 'warning' && args[0]?.name === 'ExperimentalWarning') return false;
  return _origEmit.apply(this, [event, ...args]);
};
