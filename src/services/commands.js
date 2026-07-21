// The two words every reply invites the owner to say back (CLAUDE.md > Reply
// tone): "Reply 'fix' if wrong" and, on a flagged entry, "reply 'review' to
// confirm or 'fix' to correct".

// "fix", "Fix", "fix 2400", "fix: it was rent", "fix - Naivas".
//
// \b matters: it stops "fixed the roof for 5000" being read as a command, since
// there's no word boundary between "fix" and "ed". A genuine expense that starts
// "fix the tap 500" would still be caught — acceptable, because the reply says
// plainly what it did, and the alternative (missing real corrections) is worse.
const FIX_RE = /^fix\b[\s:,-]*(.*)$/is;

// Kept strict. Loose synonyms like "ok" or "sawa" are ordinary conversation and
// would hijack messages the owner never meant as commands.
const REVIEW_RE = /^(review|confirm)\b[\s:,-]*$/i;

// "undo", "delete", "remove" — take the last entry out of the books. Kept as
// strict as REVIEW_RE and for the same reason: these are ordinary words, and
// "delete the old stock 2000" is a message about stock, not an instruction.
// Only the bare word counts.
const UNDO_RE = /^(?:undo|delete|remove|cancel)\b[\s.!]*$/i;

// "receipt", "photo", "image" — show me the picture again. Same strictness as
// the rest: "receipt from Naivas 800" is an owner recording a purchase.
const RECEIPT_RE = /^(?:receipt|photo|image|picha)\b[\s.!?]*$/i;

// "restore", "undelete" — put back what 'undo' just removed.
const RESTORE_RE = /^(?:restore|undelete|undo undo)\b[\s.!]*$/i;

// "summary", "totals", "report", optionally followed by a period: "summary today",
// "totals last week", "summary for the month".
//
// The trailing text must be a period we recognise. Anything else means this was
// never a report request — "total 5000" is far more likely to be an owner
// recording a sale than asking for one, and hijacking it would lose their money.
// parseCommand falls through to normal extraction in that case.
const SUMMARY_RE = /^(?:summary|totals?|report)\b[\s:,-]*(.*)$/is;

// 'leo' is Swahili for today, alongside the 'sawa'/'ndio' already accepted below.
const PERIOD_WORDS = [
  [/^(?:this week|week)?$/, 'week'],
  [/^(?:today|leo)$/, 'today'],
  [/^last week$/, 'last_week'],
  [/^(?:this )?month$/, 'month'],
];

/**
 * 'today' | 'week' | 'last_week' | 'month', or null when the words after the
 * command aren't a period at all. Bare "summary" means the week in progress —
 * the period an owner asking mid-week is asking about.
 */
function parsePeriod(argument) {
  const text = (argument || '')
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/^for\s+/, '')
    .replace(/\bthe\s+/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  for (const [re, name] of PERIOD_WORDS) {
    if (re.test(text)) return name;
  }
  return null;
}

// "yes", "yeah", "ok", "sawa", "ndio", "correct" — an owner agreeing that the
// entry we just put in front of them is right.
//
// This is deliberately NOT part of parseCommand. Out of nowhere, "ok" is
// ordinary conversation and treating it as a command would hijack messages the
// owner never meant that way — the same reasoning that keeps REVIEW_RE strict.
// It is only consulted while a review walk is open, where we have just asked a
// direct yes-or-no question and a bare "sawa" can only sensibly be the answer.
// Context, not vocabulary, is what makes it safe.
const AFFIRMATIVE_RE = /^(y|yes|yeah|yep|ok|okay|correct|right|sawa|ndio|ndiyo)\b[\s.!]*$/i;

function isAffirmative(text) {
  return AFFIRMATIVE_RE.test((text || '').trim());
}

/**
 * Returns { name: 'fix', argument: '2400' } | { name: 'review' } |
 * { name: 'summary', argument: 'week' } | { name: 'undo' } |
 * { name: 'restore' } | { name: 'receipt' } | null.
 *
 * For 'fix', `argument` is whatever followed the word on the same line — empty
 * when the owner just said "fix" and is waiting to be asked. For 'summary' it is
 * the resolved period name.
 */
function parseCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  if (REVIEW_RE.test(trimmed)) return { name: 'review', argument: '' };
  if (RECEIPT_RE.test(trimmed)) return { name: 'receipt', argument: '' };
  if (RESTORE_RE.test(trimmed)) return { name: 'restore', argument: '' };
  if (UNDO_RE.test(trimmed)) return { name: 'undo', argument: '' };

  const summary = SUMMARY_RE.exec(trimmed);
  if (summary) {
    const period = parsePeriod(summary[1]);
    // No recognised period: not a report request. Fall through so the message
    // gets extracted as an ordinary transaction instead of being swallowed.
    if (period) return { name: 'summary', argument: period };
  }

  const fix = FIX_RE.exec(trimmed);
  if (fix) return { name: 'fix', argument: (fix[1] || '').trim() };

  return null;
}

module.exports = { parseCommand, isAffirmative, parsePeriod };
