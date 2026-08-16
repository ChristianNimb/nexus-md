/**
 * Where this panel's own API lives.
 *
 * Both pages are served from two places and must talk to the same bot in both:
 *
 *   /            /link                 the bot serving itself, directly
 *   /bots/<slug>/panel/[link]          the same pages behind the hosting platform
 *
 * Every request used to be written `/api/…`, which is root-relative and so
 * ignores the prefix entirely. Behind the platform that sent `/api/health` to
 * the PLATFORM's health route — a real endpoint that answers 200 with a
 * perfectly valid body that simply has no `panelEnabled` field. The panel read
 * `undefined`, treated it as false, and rendered "Panel is off" over a bot that
 * was running, healthy, and waiting to be paired. Nothing failed loudly; the
 * page just asked the wrong server and believed the answer.
 *
 * A `<base>` tag does not fix it — base only affects RELATIVE URLs, and
 * `/api/health` is absolute. Deriving the prefix from our own path does, and it
 * needs no cooperation from whatever is proxying us: strip the trailing `link`
 * segment off the current pathname and whatever remains is the mount point.
 */
const API_BASE = window.location.pathname
  // A page, not a directory: /index.html, /link.html
  .replace(/\/[^/]*\.html?$/, '')
  // The panel's extensionless route
  .replace(/\/link\/?$/, '')
  .replace(/\/$/, '');

/** Builds a URL for `path` (which starts with `/`) under this panel's mount point. */
export function api(path: string): string {
  return `${API_BASE}${path}`;
}
