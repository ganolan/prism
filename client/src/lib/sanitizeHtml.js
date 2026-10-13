// Student-authored answer HTML (linked quizzes, spec §12) goes into the DOM only through
// here: text formatting, lists, code and tables. No attributes at all, so nothing can run,
// load or link.
import DOMPurify from 'dompurify';

const CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: [],
};

export const sanitizeAnswerHtml = (html) => DOMPurify.sanitize(String(html ?? ''), CONFIG);
