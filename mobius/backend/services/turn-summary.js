const fs = require('fs');
const path = require('path');
const { TURNS_SUMMARY_DIR } = require('../config');
const { Messages } = require('../repositories/messages');

// 读取 Citadel turn-summary.js hook 写入的 enriched summary, 落到 messages.turn_summary
function pollTurnSummaries(sessionId) {
  try {
    if (!fs.existsSync(TURNS_SUMMARY_DIR)) return;
    const files = fs.readdirSync(TURNS_SUMMARY_DIR).filter(f => f.startsWith(`${sessionId}-`) && f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(TURNS_SUMMARY_DIR, file);
      let summaryData;
      try {
        summaryData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        try { fs.unlinkSync(filePath); } catch {}
        continue;
      }
      if (!summaryData || !summaryData.turn_number) {
        try { fs.unlinkSync(filePath); } catch {}
        continue;
      }
      const turnNum = summaryData.turn_number;
      const summary = (summaryData.summary || '').slice(0, 200);
      if (summary) {
        const existing = Messages.findLastAssistantInTurn(sessionId, turnNum);
        if (existing) Messages.updateTurnSummary(existing.id, summary);
      }
      try { fs.unlinkSync(filePath); } catch {}
    }
  } catch { /* non-critical */ }
}

module.exports = { pollTurnSummaries };
