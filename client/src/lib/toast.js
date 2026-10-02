/** Fire-and-forget notifications, shown by <Toaster />. */
export function showToast(message, { tone = 'ok' } = {}) {
  window.dispatchEvent(new CustomEvent('smartattend:toast', { detail: { message, tone } }));
}
