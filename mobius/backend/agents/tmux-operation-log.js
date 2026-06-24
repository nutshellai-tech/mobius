const fs = require('fs')
const path = require('path')
const util = require('util')
const { spawnSync } = require('child_process')

const { TEST_ROOT } = require('../config')

const LOG_FILE = path.join(TEST_ROOT, 'logs', 'tmux-operation.log')
let warned = false

function singleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function bashAnsiQuote(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\v/g, '\\v')
    .replace(/\x1b/g, '\\e')
    .replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/g, (ch) => {
      return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
    })
  return `$'${escaped}'`
}

function shellQuote(value) {
  const s = String(value)
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  if (/[\x00-\x1f\x7f]/.test(s)) return bashAnsiQuote(s)
  return singleQuote(s)
}

function tmuxCommandString(args, opts = {}) {
  const command = ['tmux', ...args].map(shellQuote).join(' ')
  if (!Object.prototype.hasOwnProperty.call(opts, 'input')) return command
  return `printf %s ${bashAnsiQuote(opts.input ?? '')} | ${command}`
}

function shouldRecordTmuxCommand(args) {
  if (args[0] === 'capture-pane') return false
  if (args[0] === 'list-windows' && args.includes('-t')) return false
  return true
}

function recordTmuxCommand(args, opts = {}) {
  if (!shouldRecordTmuxCommand(args)) return

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${tmuxCommandString(args, opts)}\n`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn(`[tmux-operation-log] append failed (${LOG_FILE}): ${e.message}`)
    }
  }
}

function tmux(args, opts = {}) {
  recordTmuxCommand(args, opts)
  return spawnSync('tmux', args, { encoding: 'utf8', ...opts })
}

function log(...args) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${util.format(...args)}\n`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn(`[tmux-operation-log] append failed (${LOG_FILE}): ${e.message}`)
    }
  }
  console.log(...args)
}

module.exports = { LOG_FILE, log, recordTmuxCommand, shouldRecordTmuxCommand, tmux, tmuxCommandString }
