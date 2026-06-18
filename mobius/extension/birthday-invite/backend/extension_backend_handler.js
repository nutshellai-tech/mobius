/**
 * birthday-invite/backend/extension_backend_handler.js
 *
 * CommonJS handler for /api/ext. Keep it stateless and write only under ext_data_dir.
 */
const path = require('path');
const fs = require('fs/promises');

const RSVP_FILE = 'rsvps.json';
const MAX_RSVPS = 500;

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanEvent(rawEvent) {
  const event = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  return {
    title: cleanText(event.title, 80),
    time: cleanText(event.time, 80),
    place: cleanText(event.place, 120),
  };
}

module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
  const action = payload.action;
  const rsvpFile = path.join(ext_data_dir, RSVP_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'submit_rsvp') {
    const name = cleanText(payload.name, 40);
    if (!name) {
      return { ok: false, error: '请填写姓名' };
    }

    const rsvps = await readJsonArray(rsvpFile);
    rsvps.push({
      name,
      username,
      display_name,
      event: cleanEvent(payload.event),
      submitted_at: new Date().toISOString(),
    });

    await fs.writeFile(rsvpFile, JSON.stringify(rsvps.slice(-MAX_RSVPS), null, 2));
    logger && logger.info && logger.info('submit_rsvp', { username, name });
    return { ok: true, name };
  }

  return { ok: false, error: '未知操作' };
};
