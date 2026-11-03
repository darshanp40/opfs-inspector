// Markdown preview. The text comes from the site, so it is not trusted:
// the HTML is cleaned, links are limited and images are never loaded.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const LINKS = ['http:', 'https:', 'mailto:'];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A' || !node.hasAttribute('href')) return;
  let ok = false;
  try {
    ok = LINKS.includes(new URL(node.getAttribute('href')).protocol);
  } catch { /* a relative link has nowhere to go */ }
  if (ok) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  } else {
    node.removeAttribute('href');
  }
});

export function renderMarkdown(text) {
  // An image becomes its alt text, so nothing is fetched.
  const html = marked.parse(text).replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    return `<em>[image: ${(alt && (alt[1] ?? alt[2])) || 'no description'}]</em>`;
  });
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'form', 'object', 'embed', 'img', 'picture', 'source', 'video', 'audio', 'track', 'link'],
    // Attributes that fetch a URL, and ones that could pass for the panel's
    // own markup (ids, classes, data-cmd).
    FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background', 'action', 'formaction', 'ping', 'xlink:href', 'id', 'class'],
    ALLOW_DATA_ATTR: false,
  });
}
