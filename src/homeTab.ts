import { useEffect, useState } from "react";

export type HomeTab = {
  /** False until Rove knows where it is running. */
  ready: boolean;
  /** True in Chrome's side panel; false in a full-page Rove tab. */
  panel: boolean;
  /** The active tab of the side panel's window: the page the panel sits beside. */
  tabId?: number;
};

/** Where this Rove page lives. The side panel follows the active tab of its own window, so each tab
 * can show its own chat; a full-page Rove tab has no single page beside it. */
export function useHomeTab(): HomeTab {
  const [home, setHome] = useState<HomeTab>({ ready: false, panel: false });
  useEffect(() => {
    let stopped = false;
    let windowId: number | undefined;
    const activated = (info: { tabId: number; windowId: number }) => {
      if (!stopped && info.windowId === windowId) setHome({ ready: true, panel: true, tabId: info.tabId });
    };
    (async () => {
      try {
        if (typeof chrome === "undefined" || !chrome.tabs || (await chrome.tabs.getCurrent())) {
          if (!stopped) setHome({ ready: true, panel: false });
          return;
        }
        windowId = (await chrome.windows.getCurrent()).id;
        chrome.tabs.onActivated.addListener(activated);
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (!stopped) setHome({ ready: true, panel: true, tabId: tab?.id });
      } catch {
        if (!stopped) setHome({ ready: true, panel: false });
      }
    })();
    return () => {
      stopped = true;
      try {
        chrome.tabs?.onActivated.removeListener(activated);
      } catch {}
    };
  }, []);
  return home;
}

/** The tab a chat last worked in, from its recorded tool calls, results and screenshots. */
export function lastTabOf(events: { data: Record<string, any> }[] | undefined): number | undefined {
  for (const event of [...(events || [])].reverse()) {
    const id = event.data?.tabId ?? event.data?.args?.tabId ?? event.data?.result?.tabId;
    if (Number.isInteger(id)) return id;
  }
  return undefined;
}
