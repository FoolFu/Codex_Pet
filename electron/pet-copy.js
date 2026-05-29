function buildBubbleText(snapshot) {
  const state = snapshot.workflowState;
  const outcome = snapshot.outcome;
  const sessionName = snapshot.session?.threadName || '当前会话';

  if (snapshot.offline) {
    return '我先安静待命，等 Codex 新动静。';
  }

  if (state === 'done_or_error') {
    return outcome === 'error'
      ? '唔，好像撞到点小问题，我们再试一次。'
      : '这一步忙完啦，我在这继续陪你。';
  }

  const texts = {
    idle: '现在很安静，我会一直陪着你。',
    thinking: `我在认真想 ${sessionName} 的下一步。`,
    reading: '我在帮你翻代码，看看线索藏在哪儿。',
    editing: '我在小心改动文件，别担心，我很稳。',
    running: '命令跑起来了，我先替你盯着结果。',
    waiting_user: '轮到你啦，我抬头等你一句话。',
  };

  return texts[state] || '我在你身边。';
}

module.exports = {
  buildBubbleText,
};
