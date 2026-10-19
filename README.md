# FirstUPCJax MediaShare

MediaShare 1.2.0 sends a selected slide to FUPCJ Server immediately. Wait for
“received and saved” before closing the page; the server then finishes title-eyes
extraction and publishes the drop independently. Save drop saves optional Text
without waiting for OCR. Auto Title stays locked until extraction completes;
the pencil enables a correction and its Save button persists the edit.

Requires the companion Vision `media_share.py` integration and Livestream Manager
1.2.0. Model standby is Sunday/Wednesday in church PC time; on other days the same model loads on demand for MediaShare and unloads after
pending titles finish. It can process titles while OBS is running. New drops use one supported slide (JPEG/PNG/WebP/still GIF,
10 MB maximum), normalized by title-eyes. Existing multi-image history still opens.

The browser uses this app's existing Firebase anonymous sign-in. No Vision login,
private API token or external cloud OCR account is embedded in the site. The
server accepts this Firebase project only on its MediaShare routes.

A replacement image has a new image key. Completed titles and manual corrections
are tied to that key, so late old results cannot overwrite it. Use New drop for
a separate item, or Replace slide from history to change an existing item. Titles
and images update the active stream through the manager's background watcher.

Run `node --test tests/auto-title.test.cjs` for offline client/UI tests. Deployment
uses the repository's existing GitHub Pages setup. Real browser, server, Firebase,
OBS and destination checks are required after the coordinated rollout.

## Zoom and orientation

Page gestures (pinch/double-tap), Ctrl/Cmd +/- and Ctrl+wheel zoom are suppressed.
Normal scrolling and text selection remain available, and editable fields use
16px text to avoid iPhone focus zoom. Browser-menu zoom, OS accessibility zoom,
and browser settings that override website restrictions remain user-controlled.
Ctrl/Cmd+0 remains available to reset any existing browser zoom.

On touch-first devices the page requests portrait orientation where the browser
permits it. The web app manifest also requests portrait when launched as an
installed app. Orientation locking is browser-dependent and often requires an
installed app or fullscreen; this page never forces fullscreen. iPhone Safari
cannot be reliably locked by a website: enable Portrait Orientation Lock in
Control Center for a guaranteed portrait screen. Unsupported/rejected lock
requests do not interrupt uploads or editing.

Run `node --test tests/*.test.cjs` for all client checks.

## Slide preview and intake

The selected slide fills the intake area in a 16:9 frame with the whole image
visible. Other aspect ratios are letterboxed, never cropped. The scanning
feedback stays over this full-size preview. Once the slot is occupied, drag,
paste, and normal file selection cannot replace it. A blocked drag shows a
red highlight. Remove the slide, use New drop, or explicitly choose Replace
slide in history. Failed replacements restore the previous preview. Accepted
slides are recovered from published history when the page is reopened.
