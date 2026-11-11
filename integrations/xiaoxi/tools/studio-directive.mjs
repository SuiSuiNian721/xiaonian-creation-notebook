export function resolveWorkflowStage(token, stages) {
  function normalized(value) {
    return String(value || '')
      .trim()
      .replace(/[「」『』【】\[\]（）()]/g, '')
      .replace(/(?:模块|部分|设定)$/g, '')
      .replace(/\s+/g, '');
  }
  var wanted = normalized(token);
  if (!wanted || !Array.isArray(stages)) return '';
  for (var i = 0; i < stages.length; i++) {
    var stage = String(stages[i] || '');
    var base = stage.replace(/^[^/]+\//, '');
    var label = base.replace(/^\d{2}-/, '');
    if (normalized(stage) === wanted || normalized(base) === wanted || normalized(label) === wanted) return stage;
  }
  if (wanted === '世界观') {
    for (var j = 0; j < stages.length; j++) {
      var candidate = String(stages[j] || '');
      if (/\/01-(?:世界观|世界总设)$/.test(candidate)) return candidate;
    }
  }
  return '';
}

export function resetCardTrackState(state, cardTab) {
  state.cardTab = cardTab;
  state.name = null;
  state.view = null;
  state.tree = null;
  state.flowData = null;
  state.flowOpen = null;
  state.wfStage = '';
  return state;
}
