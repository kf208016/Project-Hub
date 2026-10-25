'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isInertTaskMetadata } = require('../lib/claude-task-metadata');

const VALID_NAMES = [
  'task_started',
  'task_progress',
  'task_notification',
  'task_updated',
  'background_tasks_changed',
  'task_summary'
];

test('all six exact names return true', () => {
  for (const name of VALID_NAMES) {
    assert.equal(isInertTaskMetadata(name), true);
  }
});

test('unknown system subtype names return false', () => {
  const unknown = [
    'init',
    'hook_started',
    'model_fallback',
    'api_error',
    'permission_denied',
    'result'
  ];
  for (const name of unknown) {
    assert.equal(isInertTaskMetadata(name), false);
  }
});

test('case variants return false', () => {
  assert.equal(isInertTaskMetadata('Task_Started'), false);
  assert.equal(isInertTaskMetadata('TASK_PROGRESS'), false);
  assert.equal(isInertTaskMetadata('Background_Tasks_Changed'), false);
});

test('prefix/suffix/whitespace variants return false', () => {
  assert.equal(isInertTaskMetadata(' task_started'), false);
  assert.equal(isInertTaskMetadata('task_started '), false);
  assert.equal(isInertTaskMetadata('task_started_extra'), false);
  assert.equal(isInertTaskMetadata('prefix_task_started'), false);
  assert.equal(isInertTaskMetadata('task_summaryx'), false);
});

test('non-string primitives return false without coercion', () => {
  assert.equal(isInertTaskMetadata(null), false);
  assert.equal(isInertTaskMetadata(undefined), false);
  assert.equal(isInertTaskMetadata(0), false);
  assert.equal(isInertTaskMetadata(1), false);
  assert.equal(isInertTaskMetadata(NaN), false);
  assert.equal(isInertTaskMetadata(true), false);
  assert.equal(isInertTaskMetadata(false), false);
  assert.equal(isInertTaskMetadata(() => 'task_started'), false);
  assert.equal(isInertTaskMetadata(Symbol('task_started')), false);
});

test('objects with throwing getter/toString are never invoked and return false', () => {
  const throwingObj = {
    get value() {
      throw new Error('should not be read');
    },
    toString() {
      throw new Error('should not be invoked');
    },
    valueOf() {
      throw new Error('should not be invoked');
    }
  };
  assert.doesNotThrow(() => {
    assert.equal(isInertTaskMetadata(throwingObj), false);
  });

  class Thrower {
    toString() {
      throw new Error('nope');
    }
  }
  assert.doesNotThrow(() => {
    assert.equal(isInertTaskMetadata(new Thrower()), false);
  });
});

test('string-wrapper objects are not unwrapped', () => {
  assert.equal(isInertTaskMetadata(new String('task_started')), false);
});

test('exported object is frozen and shape is minimal', () => {
  const mod = require('../lib/claude-task-metadata');
  assert.equal(Object.isFrozen(mod), true);
  assert.equal(typeof mod.isInertTaskMetadata, 'function');
  assert.deepEqual(Object.keys(mod), ['isInertTaskMetadata']);

  assert.throws(() => {
    mod.newProp = 'x';
  }, TypeError);
});

test('task_updated and background_tasks_changed payload-bearing subtypes are still just names', () => {
  // Confirms classifier does not read patch/tasks fields, only matches subtype name string
  assert.equal(isInertTaskMetadata('task_updated'), true);
  assert.equal(isInertTaskMetadata('background_tasks_changed'), true);
});
