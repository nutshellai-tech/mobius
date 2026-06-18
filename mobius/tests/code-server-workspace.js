const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
} = require('../backend/services/code-server-workspace');

function payloadFor(filePath) {
  return JSON.stringify([['openFile', `vscode-remote://localhost${filePath}`]]);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-workspace-'));

try {
  const bindPath = path.join(tmpRoot, 'project');
  const childPath = path.join(bindPath, 'src');
  const siblingPath = path.join(tmpRoot, 'sibling');
  const outsidePath = path.join(path.dirname(tmpRoot), `outside-${path.basename(tmpRoot)}`, 'note.md');
  const project = { bind_path: bindPath };

  fs.mkdirSync(childPath, { recursive: true });
  fs.mkdirSync(siblingPath, { recursive: true });

  assert.strictEqual(resolveCodeServerWorkspace(project, bindPath).workspacePath, bindPath);
  assert.strictEqual(resolveCodeServerWorkspace(project, childPath).workspacePath, childPath);
  assert.strictEqual(resolveCodeServerWorkspace(project, tmpRoot).workspacePath, tmpRoot);
  assert.strictEqual(resolveCodeServerWorkspace(project, siblingPath).code, 'BIND_PATH_DENIED');

  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(bindPath, 'README.md')), bindPath).ok,
    true,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), bindPath).ok,
    false,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), tmpRoot).ok,
    true,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(outsidePath), tmpRoot).ok,
    false,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), siblingPath).ok,
    false,
  );

  console.log('code-server workspace tests passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
