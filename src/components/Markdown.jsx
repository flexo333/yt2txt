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

// `onLinkClick`, when given, gets first refusal on every link click. It
// returns true to mean "handled" (it calls `event.preventDefault()` itself —
// kept in the caller so this component doesn't have to guess which clicks
// were actually acted on), in which case the default `target="_blank"`
// navigation never fires. Anything it doesn't recognise (or when no prop is
// passed at all) falls through to today's behaviour unchanged.
const linkComponent = (onLinkClick) =>
  function MarkdownLink({ node, href, ...props }) {
    const handleClick = onLinkClick
      ? (event) => {
          onLinkClick(href, event);
        }
      : undefined;
    return (
      <a
        {...props}
        href={href}
        onClick={handleClick}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
      />
    );
  };

const Markdown = ({ children, onLinkClick }) => (
  <ReactMarkdown urlTransform={urlTransform} components={{ a: linkComponent(onLinkClick) }}>
    {children}
  </ReactMarkdown>
);

export default Markdown;
