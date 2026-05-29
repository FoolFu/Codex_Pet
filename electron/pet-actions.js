function createPresentation(config) {
  return {
    statusLabel: config.statusLabel,
    actionSemantic: config.actionSemantic,
    presentationClass: config.presentationClass,
    candidateAssets: config.candidateAssets || [],
  };
}

function resolveActionPresentation(snapshot) {
  const state = snapshot.workflowState;
  const outcome = snapshot.outcome;

  if (snapshot.offline) {
    return createPresentation({
      statusLabel: '待命',
      actionSemantic: '待机/眨眼/轻呼吸',
      presentationClass: 'is-idle',
      candidateAssets: ['zayan', 'zt.yang', 'xinqing'],
    });
  }

  if (state === 'done_or_error') {
    return outcome === 'error'
      ? createPresentation({
          statusLabel: '出错',
          actionSemantic: '冰冻/异常卡住',
          presentationClass: 'is-bing',
          candidateAssets: ['bing'],
        })
      : createPresentation({
          statusLabel: '完成',
          actionSemantic: '开心反馈/明显正向动作',
          presentationClass: 'is-done',
          candidateAssets: ['chifan', 'shengji', 'ok'],
        });
  }

  const mapping = {
    idle: createPresentation({
      statusLabel: '待命',
      actionSemantic: '待机/眨眼/轻呼吸',
      presentationClass: 'is-idle',
      candidateAssets: ['zayan', 'zt.yang', 'xinqing'],
    }),
    thinking: createPresentation({
      statusLabel: '思考',
      actionSemantic: '停顿思考/轻微摆头',
      presentationClass: 'is-thinking',
      candidateAssets: ['zayan', 'xinqing', 'study'],
    }),
    reading: createPresentation({
      statusLabel: '读码',
      actionSemantic: '观察/翻阅/专注查看',
      presentationClass: 'is-reading',
      candidateAssets: ['xiuxian', 'study'],
    }),
    editing: createPresentation({
      statusLabel: '改码',
      actionSemantic: '忙碌工作/持续处理',
      presentationClass: 'is-editing',
      candidateAssets: ['xiuxian', 'work'],
    }),
    running: createPresentation({
      statusLabel: '执行',
      actionSemantic: '紧张等待/动作频率更快',
      presentationClass: 'is-running',
      candidateAssets: ['xizao', 'xiuxian', 'work'],
    }),
    waiting_user: createPresentation({
      statusLabel: '等你',
      actionSemantic: '抬头等待/面向用户期待回应',
      presentationClass: 'is-waiting',
      candidateAssets: ['zayan', 'lai', 'zhaoshou'],
    }),
  };

  return mapping[state] || mapping.idle;
}

module.exports = {
  resolveActionPresentation,
};
