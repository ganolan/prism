// Short labels for a course's reporting categories (#192, Graham 25 Oct 2026): the category number
// ("5") means nothing to a teacher, so the roster shows the initial of each main word of the name
// without its course prefix: "Producing" → P, "Creating, Responding, Connecting" → CRC,
// "Computational Thinking Practices" → CTP.
//
// Within one course the labels are distinct: when two collide, each colliding label takes one more
// letter of its words, first word first ("Content Knowledge" and "Computing Knowledge" → ConK, ComK),
// until they differ. Two names with the same words keep their number as a last resort.

// Words left out of the initials.
const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with']);

function mainWords(name) {
  const words = String(name ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const main = words.filter((w) => !MINOR.has(w.toLowerCase()));
  return main.length ? main : words;
}

// The label from `take[i]` letters of word i, each part starting with a capital.
function build(words, take) {
  return words.map((w, i) => {
    const part = w.slice(0, take[i]);
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join('');
}

// One more letter for the first word that still has letters to give; false when none has.
function lengthen(words, take) {
  for (let i = 0; i < words.length; i += 1) {
    if (take[i] < words[i].length) { take[i] += 1; return true; }
  }
  return false;
}

// names: the category names (course prefix already removed) → their labels, in the same order.
// fallbacks (optional): what to show when a name gives no distinct label (the category numbers).
export function categoryAbbreviations(names, fallbacks = []) {
  const words = names.map(mainWords);
  const take = words.map((ws) => ws.map(() => 1));
  const labels = words.map((ws, i) => build(ws, take[i]));
  for (let round = 0; round < 64; round += 1) {
    const seen = new Map();
    labels.forEach((l, i) => seen.set(l.toLowerCase(), [...(seen.get(l.toLowerCase()) || []), i]));
    const clashing = [...seen.values()].filter((ix) => ix.length > 1).flat();
    if (!clashing.length) break;
    let grew = false;
    for (const i of clashing) {
      if (lengthen(words[i], take[i])) { labels[i] = build(words[i], take[i]); grew = true; }
    }
    if (!grew) break;
  }
  // Still the same (identical names, or no letters at all): the fallback keeps them apart.
  const counts = new Map();
  for (const l of labels) counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) || 0) + 1);
  return labels.map((l, i) => (!l || counts.get(l.toLowerCase()) > 1 ? `${l}${fallbacks[i] ?? i + 1}` : l));
}
