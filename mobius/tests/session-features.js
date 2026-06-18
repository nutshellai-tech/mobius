const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  featureJsonlPathOf,
  gitDiffForFiles,
  listBashCommands,
  scanSessionFeatures,
  summarizeFileChanges,
} = require('../backend/services/session-features');

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-session-features-'));
const projectRoot = path.join(tmp, 'repo');
fs.mkdirSync(projectRoot, { recursive: true });
const jsonlPath = path.join(tmp, 'sample.jsonl');

appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:00.000Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd: 'npm run build',
      workdir: projectRoot,
      justification: 'Build frontend',
    }),
    call_id: 'call-1',
  },
});
appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:01.000Z',
  type: 'event_msg',
  payload: {
    type: 'patch_apply_end',
    success: true,
    changes: {
      [path.join(projectRoot, 'src/app.ts')]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
    },
  },
});
appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:02.000Z',
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'tool-bash',
        name: 'Bash',
        input: {
          command: 'node -c server.js',
          description: 'Syntax check backend',
        },
      },
      {
        type: 'tool_use',
        id: 'tool-edit',
        name: 'Edit',
        input: {
          file_path: path.join(projectRoot, 'server.js'),
          old_string: 'old',
          new_string: 'new',
        },
      },
    ],
  },
});

let scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 4);
assert.ok(fs.existsSync(featureJsonlPathOf(jsonlPath)));

let commands = listBashCommands(scanned.entries);
assert.deepStrictEqual(commands.map((cmd) => cmd.command), ['npm run build', 'node -c server.js']);
assert.strictEqual(commands[0].description, 'Build frontend');
assert.strictEqual(commands[1].description, 'Syntax check backend');

let files = summarizeFileChanges(scanned.entries, { workDir: projectRoot, gitRoot: projectRoot });
assert.deepStrictEqual(files.map((file) => file.display_path), ['server.js', 'src/app.ts']);

appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:03.000Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    status: 'completed',
    name: 'apply_patch',
    input: `*** Begin Patch
*** Add File: ${path.join(projectRoot, 'README.md')}
+hello
*** End Patch
`,
  },
});

scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 1);
assert.ok(scanned.scanned_from_offset > 0);
files = summarizeFileChanges(scanned.entries, { workDir: projectRoot, gitRoot: projectRoot });
assert.deepStrictEqual(files.map((file) => file.display_path), ['README.md', 'server.js', 'src/app.ts']);

scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 0);

runGit(projectRoot, ['init']);
runGit(projectRoot, ['config', 'user.email', 'test@example.com']);
runGit(projectRoot, ['config', 'user.name', 'Mobius Test']);
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'old\n');
runGit(projectRoot, ['add', 'src/app.ts']);
runGit(projectRoot, ['commit', '-m', 'init']);
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'committed\n');
runGit(projectRoot, ['add', 'src/app.ts']);
runGit(projectRoot, ['commit', '-m', 'change app']);
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'working\n');

const unstaged = gitDiffForFiles(projectRoot, ['src/app.ts'], 'unstaged');
assert.strictEqual(unstaged.diffs.length, 1);
assert.ok(unstaged.diffs[0].diff.includes('+working'));

const lastCommit = gitDiffForFiles(projectRoot, ['src/app.ts'], 'last_commit');
assert.strictEqual(lastCommit.diffs.length, 1);
assert.ok(lastCommit.diffs[0].diff.includes('+committed'));

console.log('session-features ok');
