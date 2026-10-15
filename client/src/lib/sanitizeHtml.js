// Student-authored answer HTML (linked quizzes, spec §12) goes into the DOM only through
// sanitizeAnswerHtml: text formatting, lists, code and tables, with no attributes at all
// (data- and aria- included), so nothing can run, load or link. Teacher-authored stems go
// through sanitizeStemHtml, which also keeps an image from an http(s) address with its alt text.
import DOMPurify from 'dompurify';

const TAGS = ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

const ANSWER = { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };
const STEM = {
  ALLOWED_TAGS: [...TAGS, 'img'], ALLOWED_ATTR: ['src', 'alt'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
};

// DOMPurify keeps data: URIs on img whatever ALLOWED_URI_REGEXP says, so stems use their own
// instance with a hook that keeps only an http(s) src (the hook never touches answers).
const stemPurify = DOMPurify(window);
stemPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'src' && !/^https?:\/\//i.test(data.attrValue)) data.keepAttr = false;
});

export const sanitizeAnswerHtml = (html) => DOMPurify.sanitize(String(html ?? ''), ANSWER);
export const sanitizeStemHtml = (html) => stemPurify.sanitize(String(html ?? ''), STEM);
