/** Initials avatar. Falls back to the first two word-initials of the name. */
function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = 'md', className = '' }) {
  return (
    <span className={`avatar avatar--${size} ${className}`.trim()} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
