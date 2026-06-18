'use strict';

const childProcess = require('child_process');
const { syncBuiltinESMExports } = require('module');

const TARGET_HELPER_TYPES = new Set(['fileWatcher', 'ptyHost', 'agentHost']);
const PATCHED = Symbol.for('mobius.codeServerIpcGuard.patched');
const CHILD_HELPER_TYPE = Symbol.for('mobius.codeServerIpcGuard.helperType');

function helperTypeFromArgs(args) {
  if (!Array.isArray(args)) return null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    let helperType = null;

    if (arg === '--type' && i + 1 < args.length) {
      helperType = String(args[i + 1]);
    } else if (arg.startsWith('--type=')) {
      helperType = arg.slice('--type='.length);
    }

    if (TARGET_HELPER_TYPES.has(helperType)) {
      return helperType;
    }
  }

  return null;
}

function isVsCodeBootstrapFork(args) {
  if (!Array.isArray(args)) return false;
  return args.some((arg) => String(arg).includes('/vscode/out/bootstrap-fork'))
    || args.some((arg) => String(arg).includes('\\vscode\\out\\bootstrap-fork'));
}

function detectHelperType(child) {
  const args = Array.isArray(child?.spawnargs) ? child.spawnargs : [];
  const helperType = helperTypeFromArgs(args);
  if (!helperType || !isVsCodeBootstrapFork(args)) return null;
  return helperType;
}

function markChild(child) {
  const helperType = detectHelperType(child);
  if (!helperType) return child;

  try {
    Object.defineProperty(child, CHILD_HELPER_TYPE, {
      value: helperType,
      configurable: true,
    });
  } catch {
    child[CHILD_HELPER_TYPE] = helperType;
  }

  return child;
}

function isVsCodeConsoleMessage(message) {
  return !!message
    && typeof message === 'object'
    && typeof message.type === 'string'
    && typeof message.severity === 'string';
}

function isBufferCompatiblePayload(message) {
  return typeof message === 'string'
    || Buffer.isBuffer(message)
    || Array.isArray(message)
    || ArrayBuffer.isView(message)
    || message instanceof ArrayBuffer;
}

function shouldSuppressPayload(message) {
  return !isBufferCompatiblePayload(message) && !isVsCodeConsoleMessage(message);
}

function describePayload(message) {
  if (message === null) return 'null';
  if (message === undefined) return 'undefined';

  const type = typeof message;
  if (type !== 'object') return type;

  const ctor = message.constructor?.name || 'Object';
  const keys = Object.keys(message).slice(0, 8).join(',') || '-';
  const typeField = typeof message.type === 'string' ? ` type=${JSON.stringify(message.type)}` : '';
  return `${ctor}${typeField} keys=${keys}`;
}

let suppressedCount = 0;
let lastLogAt = 0;

function logSuppressed(helperType, message) {
  if (process.env.CS_IPC_GUARD_LOG === '0') return;

  suppressedCount += 1;
  const now = Date.now();
  if (suppressedCount > 1 && now - lastLogAt < 5000) return;

  lastLogAt = now;
  try {
    process.stderr.write(
      `[code-server-ipc-guard] suppressed invalid IPC payload from ${helperType}: ${describePayload(message)}\n`,
    );
  } catch {
    // Ignore logging failures in the preload hook.
  }
}

function patchChildProcess() {
  if (childProcess[PATCHED]) return;

  const originalFork = childProcess.fork;
  if (typeof originalFork === 'function') {
    childProcess.fork = function forkWithIpcGuard(...args) {
      return markChild(originalFork.apply(this, args));
    };
  }

  const proto = childProcess.ChildProcess?.prototype;
  const originalEmit = proto?.emit;
  if (typeof originalEmit === 'function' && !proto[PATCHED]) {
    proto.emit = function emitWithIpcGuard(event, message, ...args) {
      if (event === 'message') {
        const helperType = this[CHILD_HELPER_TYPE] || detectHelperType(this);
        if (helperType) {
          if (!this[CHILD_HELPER_TYPE]) markChild(this);

          if (shouldSuppressPayload(message)) {
            logSuppressed(helperType, message);
            return false;
          }
        }
      }

      return originalEmit.call(this, event, message, ...args);
    };

    try {
      Object.defineProperty(proto, PATCHED, { value: true });
    } catch {
      proto[PATCHED] = true;
    }
  }

  try {
    Object.defineProperty(childProcess, PATCHED, { value: true });
  } catch {
    childProcess[PATCHED] = true;
  }

  try {
    syncBuiltinESMExports();
  } catch {
    // Older Node versions may not expose this for built-in module patching.
  }
}

function shouldPatchCurrentProcess() {
  const entrypoint = process.env.VSCODE_ESM_ENTRYPOINT;
  if (!entrypoint) return true;
  return entrypoint === 'server-main' || entrypoint.endsWith('/server-main');
}

if (shouldPatchCurrentProcess()) {
  patchChildProcess();
}

module.exports = {
  detectHelperType,
  helperTypeFromArgs,
  isBufferCompatiblePayload,
  isVsCodeConsoleMessage,
  shouldPatchCurrentProcess,
  shouldSuppressPayload,
};
