export type InAppSession = { token: string; expires_at: string };

export type InAppNotification = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: string;
  read_at: string | null;
};

export type InAppFeed = { data: InAppNotification[]; unread_count: number };

export type InAppFeedOptions = {
  getSession: (signal: AbortSignal) => Promise<InAppSession>;
  baseUrl?: string;
};

type NotificationBellOptions = InAppFeedOptions & { styleNonce?: string };

/** Browser-side client. Request session credentials from your application's authenticated server. */
export function createInAppFeed({ getSession, baseUrl = "https://api.sooner.dev" }: InAppFeedOptions) {
  const url = new URL(baseUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password) {
    throw new TypeError("The Sooner feed API requires an HTTPS origin.");
  }

  let session: InAppSession | undefined;

  async function request<T>(path: string, method: "GET" | "POST", signal: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!session || Date.parse(session.expires_at) <= Date.now() + 10_000) {
        const issued = await getSession(signal);
        if (!/^sn_feed\.[1-9A-HJ-NP-Za-km-z]{40}$/.test(issued.token) || !(Date.parse(issued.expires_at) > Date.now())) {
          throw new Error("The app returned an invalid notification feed session.");
        }
        session = issued;
      }
      const token = session.token;
      const response = await fetch(url.origin + path, {
        method,
        signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401 && attempt === 0) {
        if (session?.token === token) session = undefined;
        continue;
      }
      if (!response.ok) throw new Error(`Notification feed request failed (HTTP ${response.status}).`);
      return await response.json() as T;
    }
    throw new Error("The notification feed session expired.");
  }

  return {
    list: (signal = new AbortController().signal) => request<InAppFeed>("/in-app/feed", "GET", signal),
    markRead: (id: string, signal = new AbortController().signal) =>
      request<InAppNotification>(`/in-app/feed/${encodeURIComponent(id)}/read`, "POST", signal),
  };
}

const STYLES = `
  :host { color-scheme: light dark; display: inline-block; position: relative; font: 14px/1.45 system-ui, sans-serif; }
  button, a { font: inherit; }
  button { cursor: pointer; }
  .toggle, .panel, .action { color: var(--sooner-feed-text, CanvasText); background: var(--sooner-feed-bg, Canvas); }
  .toggle, .action { border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 8px; padding: .45rem .7rem; }
  .toggle { display: inline-flex; align-items: center; gap: .45rem; }
  .badge { background: var(--sooner-feed-accent, #4d3bd1); color: white; border-radius: 999px; padding: 0 .4rem; font-size: .8em; }
  .panel { position: absolute; inset-block-start: calc(100% + .45rem); left: 0; z-index: 20; width: min(24rem, calc(100vw - 2rem)); box-sizing: border-box; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: 12px; box-shadow: 0 12px 32px #0003; }
  h2 { margin: 0; padding: .85rem 1rem .2rem; font-size: 1rem; }
  p, ul { margin: 0; }
  .status { padding: .55rem 1rem; }
  ul { list-style: none; padding: 0; overflow: auto; max-height: min(24rem, 65vh); }
  li { overflow-wrap: anywhere; border-block-start: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); padding: .75rem 1rem; }
  li[data-unread] { border-inline-start: 3px solid var(--sooner-feed-accent, #4d3bd1); padding-inline-start: calc(1rem - 3px); }
  a { color: inherit; text-underline-offset: .18em; }
  .body { margin-block: .3rem; white-space: pre-wrap; }
  .meta { margin-block-start: .4rem; display: flex; gap: .5rem; align-items: center; justify-content: space-between; }
  time, .action { font-size: .8em; }
`;

/** Embed a notification bell. Call the returned cleanup function on unmount or sign-out. */
export function mountNotificationBell(container: HTMLElement, options: NotificationBellOptions): () => void {
  const feed = createInAppFeed(options);
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const host = document.createElement("span");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  if (options.styleNonce) style.nonce = options.styleNonce;
  style.textContent = STYLES;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "toggle";
  toggle.setAttribute("aria-controls", "notifications");
  toggle.setAttribute("aria-expanded", "false");
  toggle.append("Notifications");

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = true;
  toggle.append(badge);

  const panel = document.createElement("section");
  panel.id = "notifications";
  panel.className = "panel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "notification-heading");
  const heading = document.createElement("h2");
  heading.id = "notification-heading";
  heading.textContent = "Notifications";
  const status = document.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.textContent = "Loading notifications…";
  const list = document.createElement("ul");
  panel.append(heading, status, list);
  root.append(style, toggle, panel);
  container.append(host);

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  let refreshTask: Promise<void> | undefined;
  let snapshot: InAppFeed | undefined;
  let revision = 0;

  function showStatus(message: string) {
    status.textContent = message;
    status.hidden = !message;
  }

  function render(data: InAppFeed) {
    snapshot = data;
    badge.textContent = String(data.unread_count);
    badge.hidden = data.unread_count === 0;
    showStatus(data.data.length ? "" : "You’re all caught up.");
    // Avoid moving focus when background refreshes return the same data.
    const focusedItem = root.activeElement?.closest("li");
    const focusedId = (focusedItem as HTMLElement | null)?.dataset.id;
    const focusedControl = root.activeElement?.tagName;
    let nextFocus: HTMLElement | undefined;
    const rows = data.data.map((item) => {
      const row = document.createElement("li");
      row.dataset.id = item.id;
      row.toggleAttribute("data-unread", !item.read_at);
      const href = safePath(item.href);
      const title = document.createElement(href ? "a" : "strong");
      title.textContent = item.title;
      if (title instanceof HTMLAnchorElement && href) title.href = href;
      else title.tabIndex = -1;
      row.append(title);
      if (item.body) {
        const body = document.createElement("p");
        body.className = "body";
        body.textContent = item.body;
        row.append(body);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      const time = document.createElement("time");
      time.dateTime = item.created_at;
      time.textContent = dateFormat.format(new Date(item.created_at));
      meta.append(time);
      if (item.id === focusedId) nextFocus = title;
      if (!item.read_at) {
        const read = document.createElement("button");
        read.className = "action";
        read.type = "button";
        read.textContent = "Mark as read";
        read.setAttribute("aria-label", `Mark ${item.title} as read`);
        read.addEventListener("click", () => {
          read.disabled = true;
          void feed.markRead(item.id, signal).then((updated) => {
            if (!signal.aborted && snapshot) {
              revision++;
              const data = snapshot.data.map((entry) => entry.id === updated.id ? updated : entry);
              render({ data, unread_count: data.filter((entry) => !entry.read_at).length });
            }
          }).catch(() => {
            if (signal.aborted) return;
            read.disabled = false;
            showStatus("Couldn’t mark this notification as read. Try again.");
          });
        });
        meta.append(read);
        if (item.id === focusedId && focusedControl === "BUTTON") nextFocus = read;
      }
      row.append(meta);
      return row;
    });
    list.replaceChildren(...rows);
    if (!panel.hidden && focusedId) (nextFocus ?? toggle).focus();
  }

  function refresh() {
    if (refreshTask || signal.aborted || document.hidden) return;
    const before = revision;
    refreshTask = feed.list(signal).then((data) => {
      if (!signal.aborted && before === revision) {
        if (JSON.stringify(snapshot) === JSON.stringify(data)) showStatus(data.data.length ? "" : "You’re all caught up.");
        else render(data);
      }
    }).catch(() => {
      if (!signal.aborted) showStatus("Couldn’t load notifications. Close and reopen to retry.");
    }).finally(() => { refreshTask = undefined; });
  }

  function positionPanel() {
    if (panel.hidden) return;
    const anchor = host.getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    const gutter = 8;
    const viewport = document.documentElement.clientWidth;
    const left = Math.max(gutter, Math.min(anchor.right - width, viewport - width - gutter));
    panel.style.left = `${left - anchor.left}px`;
  }

  function setOpen(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      positionPanel();
      refresh();
    }
  }

  toggle.addEventListener("click", () => setOpen(panel.hidden === true), { signal });
  root.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape" || panel.hidden) return;
    setOpen(false);
    toggle.focus();
  }, { signal });
  document.addEventListener("pointerdown", (event) => {
    if (!event.composedPath().includes(host)) setOpen(false);
  }, { signal });
  document.addEventListener("visibilitychange", refresh, { signal });
  window.addEventListener("resize", positionPanel, { signal });
  const timer = window.setInterval(refresh, 60_000);
  refresh();

  return () => {
    lifecycle.abort();
    window.clearInterval(timer);
    host.remove();
  };
}

function safePath(path: string | null): string | null {
  if (!path?.startsWith("/") || path.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(path)) return null;
  const url = new URL(path, window.location.origin);
  return url.origin === window.location.origin ? url.href : null;
}
