const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const ts = require(path.join(__dirname, '..', 'frontend', 'node_modules', 'typescript'));

const sourcePath = path.join(__dirname, '..', 'frontend', 'src', 'services', 'assistant-voice.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-assistant-voice-text-'));
const compiledPath = path.join(tempDir, 'assistant-voice.mjs');

function cleanup() {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

process.on('exit', cleanup);

function compileModule() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
    },
  });
  fs.writeFileSync(compiledPath, output.outputText);
}

async function loadModule() {
  compileModule();
  return import(pathToFileURL(compiledPath).href);
}

async function assertSelectedModeUsesOnlyPushVoiceText(mod) {
  const content = [
    '小莫先给完整说明：第一段必须完整保留。',
    '',
    'PushVoiceToUser("只播这一句精选")',
    '',
    '第二段在精选模式不应播出。',
  ].join('\n');

  assert.strictEqual(mod.voiceTextForMessage(content, 'selected'), '只播这一句精选');
}

async function assertAllModeUsesVisibleReplyEvenWhenPushVoiceExists(mod) {
  const content = [
    '# 小莫完整回复',
    '',
    '第一段需要播报。',
    '',
    '- 第二段也需要播报。',
    '',
    'PushVoiceToUser("只播精选会漏掉正文")',
  ].join('\n');

  const text = mod.voiceTextForMessage(content, 'all');
  assert.match(text, /小莫完整回复/);
  assert.match(text, /第一段需要播报/);
  assert.match(text, /第二段也需要播报/);
  assert.doesNotMatch(text, /只播精选会漏掉正文/);
  assert.doesNotMatch(text, /PushVoiceToUser/);
}

async function assertAllModeFallsBackToPushVoiceWhenThereIsNoVisibleText(mod) {
  const content = 'PushVoiceToUser("没有正文时仍然可以播精选")';

  assert.strictEqual(mod.voiceTextForMessage(content, 'all'), '没有正文时仍然可以播精选');
}

async function assertLongTextSplitsWithoutLoss(mod) {
  const sentence = '这是一段用于检查小莫播报全部模式的长文本，分段之后不能丢失任何一句话。';
  const text = Array.from({ length: 12 }, (_, index) => `${index + 1}，${sentence}`).join('');
  const chunks = mod.splitVoiceTextForSpeech(text, 220);

  assert.ok(chunks.length > 1, 'long text should split into multiple chunks');
  assert.strictEqual(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 220));
}

async function main() {
  const mod = await loadModule();
  await assertSelectedModeUsesOnlyPushVoiceText(mod);
  await assertAllModeUsesVisibleReplyEvenWhenPushVoiceExists(mod);
  await assertAllModeFallsBackToPushVoiceWhenThereIsNoVisibleText(mod);
  await assertLongTextSplitsWithoutLoss(mod);
  console.log('assistant-voice-text: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
