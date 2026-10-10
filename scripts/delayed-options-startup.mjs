/** Test-only scheduling gate, prepended to a disposable COPY of the options bundle.
 * Actual storage/message calls and results are preserved; only the first preference
 * completion is held until the harness releases it. Never ship this in dist/.
 */
export const DELAYED_OPTIONS_STARTUP = `(() => {
  const storage = browser.storage.local;
  const get = storage.get;
  const runtime = browser.runtime;
  const send = runtime.sendMessage;
  let released = false;
  const snapshots = new Map();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  storage.get = function(...args) {
    storage.get = get;
    const result = get.apply(this, args);
    document.documentElement.dataset.startupGate = "held";
    return result.then(value => gate.then(() => value));
  };
  runtime.sendMessage = function(...args) {
    const result = send.apply(this, args);
    const type = args[0]?.type;
    if (released && (type === "profiles:list" || type === "state:get") && !snapshots.has(type)) {
      snapshots.set(type, result);
      if (snapshots.size === 2) {
        runtime.sendMessage = send;
        Promise.all([...snapshots.values()]).then(() => setTimeout(() => {
          document.documentElement.dataset.startupGate = "settled";
        }, 0));
      }
    }
    return result;
  };
  document.addEventListener("ni-test-release-startup", () => {
    released = true;
    release();
  }, {once: true});
})();\n`;
