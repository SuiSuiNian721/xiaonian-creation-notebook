import { prepareWorkflowDatasetLayout } from './training-workflow-dataset.mjs';

export function prepareMusubiWorkflowDataset(options) {
  return prepareWorkflowDatasetLayout(options, 'musubi');
}
