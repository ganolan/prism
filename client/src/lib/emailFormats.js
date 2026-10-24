// The two ways a list of email addresses is copied (Class Tools' Email List, the roster's Copy emails,
// #160): Outlook's "Name <address>; ..." or bare addresses separated by commas. `textFor` picks the
// text from a GET /api/tools/emails answer ({ formatted, addresses }).
export const EMAIL_FORMATS = [
  { id: 'named', label: 'Names + emails (Outlook, ; separated)' },
  { id: 'bare', label: 'Emails only (, separated)' },
];

export const emailText = (result, format) => (!result ? '' : format === 'bare' ? result.addresses.join(', ') : result.formatted);
