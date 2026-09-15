const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ESCAPES[char]);
