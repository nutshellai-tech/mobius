import { extCall } from '/extension/_sdk/ext.js';

const INVITE_COPY = {
  title: '生日派对邀请',
  intro: '想把这一晚留给蛋糕、灯光和朋友。来一起吃饭、聊天，也给这一年留下热闹的一页。',
  time: '2026 年 7 月 18 日 18:30',
  place: '星光花园餐厅 · 露台包间',
};

const titleEl = document.getElementById('partyTitle');
const introEl = document.getElementById('partyIntro');
const timeEl = document.getElementById('partyTime');
const placeEl = document.getElementById('partyPlace');
const form = document.getElementById('rsvpForm');
const nameInput = document.getElementById('guestName');
const submitBtn = document.getElementById('submitBtn');
const confirmationEl = document.getElementById('confirmation');
const saveStateEl = document.getElementById('saveState');
const formHintEl = document.getElementById('formHint');

function applyInviteCopy() {
  document.title = INVITE_COPY.title;
  titleEl.textContent = INVITE_COPY.title;
  introEl.textContent = INVITE_COPY.intro;
  timeEl.textContent = INVITE_COPY.time;
  placeEl.textContent = INVITE_COPY.place;
}

function setSaveState(message, isError = false) {
  saveStateEl.textContent = message;
  saveStateEl.classList.toggle('error', isError);
}

function setConfirmation(name) {
  confirmationEl.hidden = false;
  confirmationEl.textContent = `已收到，${name}，期待见到你。`;
}

function normalizeName(value) {
  return value.replace(/\s+/g, ' ').trim();
}

async function submitRsvp(event) {
  event.preventDefault();

  const guestName = normalizeName(nameInput.value);
  if (!guestName) {
    nameInput.focus();
    setSaveState('请先填写你的名字。', true);
    return;
  }

  submitBtn.disabled = true;
  setSaveState('正在确认...');

  try {
    const response = await extCall({
      action: 'submit_rsvp',
      name: guestName,
      event: {
        title: INVITE_COPY.title,
        time: INVITE_COPY.time,
        place: INVITE_COPY.place,
      },
    });
    const confirmedName = response.name || guestName;
    setConfirmation(confirmedName);
    setSaveState('确认已保存。');
    formHintEl.textContent = '你可以修改名字后再次提交。';
    nameInput.value = confirmedName;
  } catch (error) {
    setConfirmation(guestName);
    setSaveState(error.message || '确认已显示，但暂时没有保存成功。', true);
  } finally {
    submitBtn.disabled = false;
  }
}

applyInviteCopy();
form.addEventListener('submit', submitRsvp);
