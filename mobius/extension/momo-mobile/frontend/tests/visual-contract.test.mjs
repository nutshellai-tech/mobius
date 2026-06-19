import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(testDir, '..')
const css = fs.readFileSync(path.join(frontendDir, 'preview.css'), 'utf8')
const indexHtml = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8')
const previewHtml = fs.readFileSync(path.join(frontendDir, 'preview.html'), 'utf8')
const previewJs = fs.readFileSync(path.join(frontendDir, 'preview.js'), 'utf8')

test('composer uses a 44px primary control height with a smaller attachment button', () => {
  assert.match(css, /--composer-control-size:\s*44px/)
  assert.match(css, /--composer-utility-size:\s*34px/)
  assert.match(css, /\.message-input\s*\{[^}]*min-height:\s*var\(--composer-control-size\)/s)
  assert.match(css, /\.upload-btn\s*\{[^}]*width:\s*var\(--composer-utility-size\)/s)
  assert.match(css, /\.mode-switch\s*\{[^}]*width:\s*var\(--composer-control-size\)/s)
  assert.match(css, /\.send\s*\{[^}]*width:\s*var\(--composer-control-size\)/s)
})

test('voice mode uses a wechat-style nine-square keyboard icon', () => {
  assert.match(previewJs, /icon-keyboard-grid/)
  assert.match(previewJs, /Array\.from\(\{\s*length:\s*9\s*\}/)
  assert.match(css, /\.icon-keyboard-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*1fr\)/s)
})

test('clone model picker loads server options and renders an unclipped scrollable panel', () => {
  assert.match(previewJs, /\/api\/sessions\/model-options/)
  assert.match(previewJs, /clone-model-options/)
  assert.doesNotMatch(previewJs, /<select id="cloneModel">/)
  assert.match(css, /\.clone-model-options\s*\{[^}]*overflow-y:\s*auto/s)
  assert.match(css, /\.sheet\s*\{[^}]*max-height:/s)
})

test('composer protects mobile text composition from background rerenders', () => {
  assert.match(previewJs, /compositionstart/)
  assert.match(previewJs, /compositionend/)
  assert.match(previewJs, /captureInputSelection/)
  assert.match(previewJs, /restoreInputSelection/)
})

test('favicon links are cache-busted and explicitly identify the round icon', () => {
  for (const html of [indexHtml, previewHtml]) {
    assert.match(html, /rel="icon"[^>]+href="\.\/favicon\.svg\?v=momo-orb-2"/)
    assert.match(html, /rel="shortcut icon"[^>]+href="\.\/favicon\.svg\?v=momo-orb-2"/)
    assert.match(html, /rel="apple-touch-icon"[^>]+href="\.\/favicon\.svg\?v=momo-orb-2"/)
  }
})

test('settings expose an interactive persisted theme control', () => {
  assert.match(previewJs, /id="themeToggle"/)
  assert.match(previewJs, /momo-preview-theme-mode/)
  assert.doesNotMatch(previewJs, /classList\.toggle\(['"]dark['"],\s*false\)/)
  assert.match(css, /body\[data-theme="dark"\]/)
  assert.match(css, /body\[data-theme="light"\]/)
})

test('theme is resolved before the stylesheet loads to avoid a light-mode flash', () => {
  for (const html of [indexHtml, previewHtml]) {
    const themeBootstrap = html.indexOf('momo-preview-theme-mode')
    const stylesheet = html.indexOf('rel="stylesheet"')
    assert.ok(themeBootstrap >= 0, 'theme bootstrap script is missing')
    assert.ok(themeBootstrap < stylesheet, 'theme bootstrap must run before CSS loads')
  }
})
