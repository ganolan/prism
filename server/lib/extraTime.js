// Extra time for a learning plan (#160, Test day). suggestExtraTime reads plan text (a Support Summary
// description) and suggests the percentage of extra time it states, or null. Prism only suggests: the
// teacher confirms the figure, and the confirmed figure lives in student_extra_time (routes/extraTime.js).

export const MAX_EXTRA_TIME_PERCENT = 200;

const PERCENT = /(\d+(?:\.\d+)?)\s*%(?!\s*of\b)/; // "80% of the time" is how often, not how much (#189)
const WORD_TIME = /\btime\b/i;
const TIME_AND_A_HALF = /\btime\s+and\s+a\s+half\b/i;

// A percentage counts only in the same sentence as the word "time", and never as "N% of ...": "Seat near
// the front (25% of lessons)" is about seating, "80% of the time" is how often. "Time and a half" is 50. Any other wording ("double time") gives null.
// A figure the store would refuse (0, or over 200) gives null too. Whole numbers.
export function suggestExtraTime(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const sentence of text.split(/[.!?;\n]+(?=\s|$)/)) {
    if (!WORD_TIME.test(sentence)) continue;
    const match = sentence.match(PERCENT);
    if (match) {
      const percent = Math.round(Number(match[1]));
      if (percent >= 1 && percent <= MAX_EXTRA_TIME_PERCENT) return percent;
    }
  }
  return TIME_AND_A_HALF.test(text) ? 50 : null;
}
