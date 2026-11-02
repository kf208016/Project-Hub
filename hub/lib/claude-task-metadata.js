'use strict';

const INERT_TASK_METADATA_SUBTYPES = [
  'task_started',
  'task_progress',
  'task_notification',
  'task_updated',
  'background_tasks_changed',
  'task_summary'
];

function isInertTaskMetadata(value) {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < INERT_TASK_METADATA_SUBTYPES.length; i++) {
    if (value === INERT_TASK_METADATA_SUBTYPES[i]) return true;
  }
  return false;
}

module.exports = Object.freeze({ isInertTaskMetadata });
