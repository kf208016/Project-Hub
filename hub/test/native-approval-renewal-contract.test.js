'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeProviderApprovals } = require('../lib/native-provider-approvals');

const scope = { actor: 'grok', project: 'synthetic', task: 'task-1', model: 'grok-4.6', effort: 'low' };
const binding = {
  project: scope.project,
  task: scope.task,
  dir: 'C:\\Synthetic\\workspace',
  rootFingerprint: 'a'.repeat(64),
  workspaceRun: 'run-1'
};
const candidate = () => ({
  binding: { ...binding },
  descriptor: {
    scope: {
      actor: scope.actor,
      project: scope.project,
      task: scope.task,
      runtimeProfileId: 'runtime-1',
      accountProfileId: 'local-profile-1',
      rootFingerprint: binding.rootFingerprint
    }
  },
  review: {
    destination: 'xAI',
    authenticationRead: ['synthetic-auth.json'],
    lockWrite: 'synthetic-auth.json.lock',
    sessionWrite: 'synthetic-state',
    credentialContentVisibleToOwnCliTools: true
  }
});
const consent = token => ({
  token,
  confirm: true,
  ackAuthenticationRead: true,
  ackCommandAccess: true,
  ackDestination: true,
  ackSessionWrite: true
});

test('authorize drops a live grant whose remaining lifetime is shorter than requested maxWallMs', async () => {
  let now = 1000, mono = 1000;
  const store = new NativeProviderApprovals({
    describe: async () => ({
      ...candidate(),
      descriptor: {
        ...candidate().descriptor,
        maxWallMs: 1800000,
        launchOptions: { maxWallMs: 1800000 }
      }
    }),
    now: () => now,
    monotonic: () => mono
  });
  const preview = await store.preview(scope);
  await store.approve(consent(preview.token));
  now += 2000000;
  mono += 2000000;
  await assert.rejects(() => store.authorize(scope, binding), { code: 'NATIVE_PROVIDER_APPROVAL_REQUIRED' });
  await assert.rejects(() => store.authorize(scope, binding), { code: 'NATIVE_PROVIDER_APPROVAL_REQUIRED' });
});

test('already-expired grant still yields NATIVE_APPROVAL_EXPIRED or NATIVE_PROVIDER_APPROVAL_REQUIRED', async () => {
  let now = 1000, mono = 1000;
  const nearExpiry = new NativeProviderApprovals({
    describe: async () => ({
      ...candidate(),
      descriptor: {
        ...candidate().descriptor,
        maxWallMs: 240000,
        launchOptions: { maxWallMs: 240000 }
      }
    }),
    now: () => now,
    monotonic: () => mono
  });
  const nearPreview = await nearExpiry.preview(scope);
  await nearExpiry.approve(consent(nearPreview.token));
  now += 3599500;
  mono += 3599500;
  await assert.rejects(() => nearExpiry.authorize(scope, binding), e => ['NATIVE_APPROVAL_EXPIRED', 'NATIVE_PROVIDER_APPROVAL_REQUIRED'].includes(e.code));

  now = 1000;
  mono = 1000;
  const pruned = new NativeProviderApprovals({
    describe: async () => candidate(),
    now: () => now,
    monotonic: () => mono
  });
  const prunedPreview = await pruned.preview(scope);
  await pruned.approve(consent(prunedPreview.token));
  now += 3600000;
  mono += 3600000;
  await assert.rejects(() => pruned.authorize(scope, binding), { code: 'NATIVE_PROVIDER_APPROVAL_REQUIRED' });
});
