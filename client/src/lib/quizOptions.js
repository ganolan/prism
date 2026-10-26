// Schoology option text often repeats its own letter ("a. ...", "b) ..."); the row already shows it.
// Shared by the Questions tab and the Attempts tab (#200).
export const stripOptionLetter = (html, letter) =>
  (html || '').replace(new RegExp(`^((?:\\s|<[^>]+>)*)${letter}[.)](?:\\s|&nbsp;)+`, 'i'), '$1');
