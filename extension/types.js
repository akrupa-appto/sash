// Shared constants for the ChatGPT-parity work: badge states, blocking request
// kinds, blocked reasons, and the shape of one step-log entry.

/** What the toolbar badge is saying about a run. */
export const BadgeState = {
  WORKING: 'working',
  DELIVERABLE: 'deliverable',
  HANDOFF: 'handoff',
  NONE: 'none',
};

/**
 * Kinds of blocking request a turn can raise.
 * Key order is priority order, highest first: a turn that raises several picks
 * the first of these that it matched, so never reorder without a reason.
 */
export const RequestType = {
  USER_INPUT: 'user_input',
  OPTION_PICKER: 'option_picker',
  SETUP_STEP: 'setup_step',
  APPROVAL: 'approval',
  PERMISSION_REQUEST: 'permission_request',
  ELICITATION: 'elicitation',
  PLAN: 'plan',
};

/** Why the page stopped the run rather than the run stopping itself. */
export const BlockedReason = {
  CAPTCHA_FAILED: 'captcha_failed',
  ACCESS_DENIED: 'access_denied',
  CHALLENGE_LOOP: 'challenge_loop',
  UNEXPECTED_BOT_ERROR: 'unexpected_bot_error',
};

/**
 * One action as the step log shows it, in its four written forms.
 * @typedef {object} StepLogEntry
 * @property {string} ticker the one-line present-tense form that scrolls by
 * @property {string} expanded the full sentence shown when the step is opened
 * @property {string} fragment the clause that reads mid-sentence, lowercase
 * @property {string} fragmentCapitalized the same clause starting a sentence
 */
