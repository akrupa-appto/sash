import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadgeState, RequestType, BlockedReason } from './extension/types.js';

test('badge states and blocked reasons are the agreed values', () => {
  assert.deepEqual(BadgeState, {
    WORKING: 'working',
    DELIVERABLE: 'deliverable',
    HANDOFF: 'handoff',
    NONE: 'none',
  });
  assert.deepEqual(BlockedReason, {
    CAPTCHA_FAILED: 'captcha_failed',
    ACCESS_DENIED: 'access_denied',
    CHALLENGE_LOOP: 'challenge_loop',
    UNEXPECTED_BOT_ERROR: 'unexpected_bot_error',
  });
});

test('request types keep their values and their priority order, highest first', () => {
  assert.deepEqual(RequestType, {
    USER_INPUT: 'user_input',
    OPTION_PICKER: 'option_picker',
    SETUP_STEP: 'setup_step',
    APPROVAL: 'approval',
    PERMISSION_REQUEST: 'permission_request',
    ELICITATION: 'elicitation',
    PLAN: 'plan',
  });
  // Declaration order is the contract: picking one blocking state per turn
  // walks these keys and takes the first match.
  assert.deepEqual(Object.keys(RequestType), [
    'USER_INPUT',
    'OPTION_PICKER',
    'SETUP_STEP',
    'APPROVAL',
    'PERMISSION_REQUEST',
    'ELICITATION',
    'PLAN',
  ]);
});
