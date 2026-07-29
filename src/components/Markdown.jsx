import ReactMarkdown from 'react-markdown';

// Model output is untrusted text, so links get both a protocol allow-list and
// hardened rel attributes. Every place that renders model markdown must use
// this component rather than ReactMarkdown directly, or the hardening only
// applies to whichever call site remembered it.

// Anything that is not http(s) or mailto — javascript:, data:, vbscript: —
// is dropped rather than rendered as a live link.
const urlTransform = (url) => {
  try {
    const u = new URL(url, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? url : '';
  } catch {
    return '';
  }
};

const components = {
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow ugc" />
  ),
};

const Markdown = ({ children }) => (
  <ReactMarkdown urlTransform={urlTransform} components={components}>{children}</ReactMarkdown>
);

export default Markdown;
