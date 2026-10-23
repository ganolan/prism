// "Add update" on the grade card's comment (#176): a dated line a teacher fills in when a
// grade changes after an appeal. It goes above the comment, but below Prism's own status line.
// Pure: the card passes the comment, the status line on top (or null) and the date text.

/**
 * @param {string} comment    the comment as it stands in the textarea
 * @param {string|null} topLine  a status line that is the comment's first line (verbatim), else null
 * @param {string} dateText   e.g. "23/10/2026"
 * @returns {{ text: string, cursor: number } | null}  null when the comment is empty
 */
export function addUpdateLine(comment, topLine, dateText) {
  const current = String(comment ?? '').replace(/\r\n/g, '\n');
  if (!current.trim()) return null;
  const prefix = `Update (${dateText}): `;
  const onTop = topLine && (current === topLine || current.startsWith(`${topLine}\n`));
  // Insertion point: after the status line and the blank line below it, else the very start.
  const head = onTop ? `${topLine}\n\n` : '';
  const rest = onTop ? current.slice(topLine.length).replace(/^\n+/, '') : current;
  // Pressed again the same day: leave the text alone and put the cursor at the end of that line.
  if (rest.startsWith(prefix)) {
    const eol = rest.indexOf('\n');
    return { text: current, cursor: current.length - rest.length + (eol === -1 ? rest.length : eol) };
  }
  const tail = rest ? `\n\n${rest}` : '';
  return { text: `${head}${prefix}${tail}`, cursor: head.length + prefix.length };
}
