// The request queue: every way a turn can stop and wait for the human, in one place.
//
// A turn may notice several reasons to ask at once (a login wall and an approval, say). It still
// gets exactly one card: `pickBlocking` walks `RequestType` in its declared priority order and
// returns the last request of the highest-priority kind, so two cards never race for one answer.
// Stopping is not the same as dropping: `declineAll` writes an explicit outcome for every pending
// request, so nothing is left waiting for an answer that will never come.

import { RequestType, BlockedReason } from './types.js';

/** How far an approval reaches. The widest one is confirmed twice. */
export const ApprovalScope = {
  ONCE: 'once',
  CONVERSATION: 'conversation',
  ALWAYS: 'always',
};

/** How a request ended. A credential handoff reports one of these, never a guess. */
export const RequestOutcome = {
  SUBMITTED: 'submitted',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
  EXPIRED: 'expired',
  ORIGIN_CHANGED: 'origin_changed',
  PAGE_CHANGED: 'page_changed',
  LOCATOR_INVALID: 'locator_invalid',
  SUBMISSION_FAILED: 'submission_failed',
  USER_TOOK_OVER: 'user_took_over',
};

/** A handoff form shows at most this many fields: more than that is a page to fill by hand. */
export const MAX_CREDENTIAL_FIELDS = 6;
/** Ask the same thing this many times and get declined every time, and the turn ends instead. */
export const DENIAL_LIMIT = 3;

const PRIORITY = Object.values(RequestType);

/** What each blocked reason reads like in the panel. Plain language, no codes. */
export const BLOCKED_TEXT = {
  [BlockedReason.CAPTCHA_FAILED]: 'a captcha on this page failed, so i could not get past it',
  [BlockedReason.ACCESS_DENIED]: 'the site denied access to this page',
  [BlockedReason.CHALLENGE_LOOP]: 'the site kept sending me back through the same challenge',
  [BlockedReason.UNEXPECTED_BOT_ERROR]: 'the site stopped me with a bot-protection error i did not expect',
};

/** True for one of the four agreed reasons, so a model cannot invent a fifth. */
export const isBlockedReason = reason => Object.values(BlockedReason).includes(reason);

/** The sentence the panel shows for a blocked reason, or undefined when the reason is not one of ours. */
export function blockedText(reason) {
  return isBlockedReason(reason) ? BLOCKED_TEXT[reason] : undefined;
}

let counter = 0;
const nextId = type => `${type}-${++counter}`;
const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The one request the panel should render, or undefined when nothing is pending.
 * Priority first (RequestType key order), then the most recent of that kind: a turn is scanned
 * backwards so the newest state of a repeated kind wins.
 */
export function pickBlocking(requests = []) {
  const pending = requests.filter(r => r && r.type && !r.outcome);
  for (const type of PRIORITY) {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].type === type) return pending[i];
  }
  return undefined;
}

/** Ask the user something mid-run: a picker when there are options, free text when there are not. */
export function askRequest({ question, options, why } = {}) {
  const choices = (Array.isArray(options) ? options : []).map(text).filter(Boolean).slice(0, 8);
  return {
    id: nextId(choices.length ? RequestType.OPTION_PICKER : RequestType.USER_INPUT),
    type: choices.length ? RequestType.OPTION_PICKER : RequestType.USER_INPUT,
    question: text(question) || text(why) || 'i need one more detail to carry on.',
    ...(choices.length ? { options: choices, allowFreeText: true } : {}),
    ...(text(why) ? { why: text(why) } : {}),
  };
}

/**
 * Ask permission for an action, in three scopes rather than yes/no.
 * The widest scope — access to every site — carries a second confirm with an explicit warning;
 * a single-origin "always" does not, because it is not the dangerous one.
 */
export function approvalRequest({ action, origin, why, type = RequestType.APPROVAL } = {}) {
  const wholeInternet = !text(origin) || text(origin) === '*';
  return {
    id: nextId(type),
    type,
    action: text(action) || text(why) || 'continue',
    ...(text(origin) ? { origin: text(origin) } : {}),
    ...(text(why) ? { why: text(why) } : {}),
    wholeInternet,
    scopes: [
      { id: ApprovalScope.ONCE, label: 'allow once' },
      { id: ApprovalScope.CONVERSATION, label: 'allow for this conversation' },
      {
        id: ApprovalScope.ALWAYS,
        label: 'always allow',
        ...(wholeInternet
          ? {
              confirm: {
                title: 'always allow on every site?',
                warning: 'this lets checkto act on any site you open, without asking again. only do this if you trust every page you will have open while it runs.',
                accept: 'yes, always allow',
                cancel: 'go back',
              },
            }
          : {}),
      },
    ],
    denyLabel: 'deny',
  };
}

// An input's type and the field's name together say what a browser would autofill here.
function autocompleteHint(inputType, label) {
  const name = `${label}`.toLowerCase();
  if (inputType === 'password') return /new|confirm|repeat/.test(name) ? 'new-password' : 'current-password';
  if (inputType === 'email') return 'email';
  if (inputType === 'tel') return 'tel';
  if (/one[- ]?time|verification|\botp\b|\bcode\b/.test(name)) return 'one-time-code';
  if (/e-?mail/.test(name)) return 'email';
  if (/user|login|account|sign[- ]?in/.test(name)) return 'username';
  return undefined;
}

/**
 * One field of the handoff form. The page's current value is deliberately not carried:
 * the form describes the field, the user supplies the secret, and nothing reads it back.
 */
export function credentialField({ id, label, inputType = 'text', required = false } = {}) {
  const type = text(inputType) || 'text';
  const name = text(label) || type;
  const hint = autocompleteHint(type, name);
  return {
    ...(Number.isInteger(id) ? { elementId: id } : {}),
    label: name,
    inputType: type,
    ...(hint ? { autocomplete: hint } : {}),
    secret: type === 'password',
    required: !!required,
  };
}

/**
 * Hand the page back with a typed form: where we are, what to fill, how else to sign in, and what
 * the submit control is. `fields` is rebuilt through `credentialField`, so a value read off the
 * page can never travel in a request — the agent resumes from page state, not from what was typed.
 */
export function credentialRequest({ origin, fields = [], signInOptions = [], submit, screenshot, why } = {}) {
  return {
    id: nextId('credential'),
    type: RequestType.USER_INPUT,
    kind: 'credential',
    origin: text(origin),
    question: `sign in to ${text(origin) || 'this site'} to carry on. i cannot see or store what you type.`,
    fields: fields.slice(0, MAX_CREDENTIAL_FIELDS).map(credentialField),
    ...(signInOptions.length ? { signInOptions: signInOptions.map(text).filter(Boolean).slice(0, MAX_CREDENTIAL_FIELDS) } : {}),
    ...(submit ? { submit: { label: text(submit.label) || 'submit', ...(Number.isInteger(submit.id) ? { elementId: submit.id } : {}) } } : {}),
    ...(text(screenshot) ? { screenshot: text(screenshot) } : {}),
    ...(text(why) ? { why: text(why) } : {}),
    outcomes: Object.values(RequestOutcome),
  };
}

/**
 * End every pending request with a real outcome. Stopping a run must not leave a card alive
 * waiting on an answer, so each pending request type gets its own decline.
 */
export function declineAll(requests = [], reason = 'stopped') {
  return requests
    .filter(r => r && r.type && !r.outcome)
    .map(r => ({ id: r.id, type: r.type, ...(r.kind ? { kind: r.kind } : {}), outcome: RequestOutcome.DECLINED, reason }));
}

/** Stable across turns: the same ask must count towards the same denial tally next time. */
export function denialKey(request) {
  if (!request?.type) return '';
  const subject = text(request.action) || text(request.origin) || text(request.question) || '';
  return `${request.type}:${subject.toLowerCase().slice(0, 120)}`;
}

/**
 * Identity for a *grant*, not a denial tally: deliberately narrower than `denialKey`.
 * `denialKey` folds origin into the subject only when there is no action text, which is fine for
 * counting refusals of "the same ask" but wrong for authorizing one — two approvals with identical
 * free-text action wording on two different sites must not share a grant. This always keys on
 * type + origin + action/question as three separate parts, so a grant never reaches past the exact
 * origin and exact action it was given for. A planner's action text names its specifics (an amount,
 * an item, a recipient), so a materially different action also produces a different key here and is
 * asked about again — the intended, conservative failure mode for anything that authorizes a repeat.
 */
export function grantKey(request) {
  if (!request?.type) return '';
  const origin = text(request.origin) || '*';
  const subject = text(request.action) || text(request.question) || '';
  return `${request.type}:${origin}:${subject.toLowerCase().slice(0, 200)}`;
}

/** True once the user has turned the same request down DENIAL_LIMIT times. */
export function denialsExhausted(request, denials = {}) {
  return (denials?.[denialKey(request)] ?? 0) >= DENIAL_LIMIT;
}

/** What the turn says instead of asking a fourth time. */
export function denialCutoffMessage(request, denials = {}) {
  const count = denials?.[denialKey(request)] ?? DENIAL_LIMIT;
  const what = text(request?.action) || text(request?.question) || 'the same thing';
  return `i stopped this turn after ${count} denials: you turned down ${what} every time i asked, so i will not ask again. add more detail, or change what checkto is allowed to do, and send it again.`;
}
