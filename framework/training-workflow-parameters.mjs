import { trainingDuration, normalizeTrainingDuration, trainingSubmission } from '../public-workbench/training-form-fields.js';

// Only generated policy values are restricted to the native schema. Explicit
// advanced values stay intact and are validated by the selected engine.
export function workflowPolicy(form, strategy) {
  const keys = new Set(form.sections.flatMap(section => section.fields).map(field => field.key));
  return Object.fromEntries(Object.entries({ ...strategy?.training, ...strategy?.dataset }).filter(([key]) => keys.has(key)));
}

export function basicWorkflowParameters(form, config, plan) {
  const keys = new Set(form.sections.flatMap(section => section.fields).map(field => field.key));
  const result = { ...config, ...workflowPolicy(form, plan.strategy) }, duration = trainingDuration(form);
  if (duration.stepKey) {
    result[duration.stepKey] = plan.steps;
    if (duration.kind === 'choice') delete result[duration.epochKey];
    if (duration.modeKey) result[duration.modeKey] = 'steps';
  } else plan.steps = null;
  const rankKey = keys.has('network_dim') ? 'network_dim' : keys.has('rank') ? 'rank' : null;
  const alphaKey = keys.has('network_alpha') ? 'network_alpha' : keys.has('alpha') ? 'alpha' : null;
  if (rankKey) result[rankKey] = plan.rank;
  if (alphaKey) result[alphaKey] = Math.min(plan.rank, config[alphaKey] || plan.rank);
  const rateKey = keys.has('learning_rate') ? 'learning_rate' : keys.has('lr') ? 'lr' : null;
  if (rateKey) result[rateKey] = plan.learningRate;
  return trainingSubmission(form, normalizeTrainingDuration(form, result));
}
