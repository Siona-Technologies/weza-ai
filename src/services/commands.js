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
 * Returns { name: 'fix', argument: '2400' } | { name: 'review' } | null.
 * `argument` is whatever followed "fix" on the same line — empty when the owner
 * just said "fix" and is waiting to be asked.
 */
function parseCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  if (REVIEW_RE.test(trimmed)) return { name: 'review', argument: '' };

  const fix = FIX_RE.exec(trimmed);
  if (fix) return { name: 'fix', argument: (fix[1] || '').trim() };

  return null;
}

module.exports = { parseCommand, isAffirmative };
