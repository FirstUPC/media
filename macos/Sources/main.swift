import AppKit
import Darwin
import Foundation
import UniformTypeIdentifiers
import WebKit

private let mediaURL = URL(string: "https://firstupc.github.io/media/")!

/// Navigation restrictions apply only to top-level documents. Firebase, fonts,
/// modules, and FUPCJ requests remain ordinary web subresources under WKWebView.
private enum MediaNavigation {
    static func isOfficial(_ url: URL?) -> Bool {
        guard let url = url, url.scheme?.lowercased() == "https",
              url.host?.lowercased() == "firstupc.github.io",
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443 else { return false }
        let path = url.path
        return path == "/media" || path.hasPrefix("/media/")
    }

    static func isDownloadURL(_ url: URL?) -> Bool {
        guard let url = url else { return false }
        if isOfficial(url) { return true }
        if url.scheme == "data" { return true }
        return url.absoluteString.hasPrefix("blob:https://firstupc.github.io/")
    }
}

/// A small native AppKit progress bar keeps the original icon's warm palette.
/// An indeterminate segment is used only when the update/network API has no
/// measurable total; download progress uses the real supplied fraction.
private final class GoldProgressIndicator: NSView {
    var isIndeterminate = true { didSet { needsDisplay = true } }
    var doubleValue = 0.0 { didSet { needsDisplay = true } }
    private var phase = 0.0
    private var timer: Timer?

    override var intrinsicContentSize: NSSize { NSSize(width: 300, height: 7) }
    override func draw(_ dirtyRect: NSRect) {
        let track = NSBezierPath(roundedRect: bounds, xRadius: 3.5, yRadius: 3.5)
        NSColor(calibratedRed: 0.89, green: 0.72, blue: 0.39, alpha: 0.16).setFill()
        track.fill()
        NSGraphicsContext.saveGraphicsState()
        track.addClip()
        let width = isIndeterminate ? bounds.width * 0.28 : bounds.width * CGFloat(min(1, max(0, doubleValue / 100)))
        let x = isIndeterminate ? CGFloat(phase) * (bounds.width + width) - width : 0
        NSColor(calibratedRed: 0.91, green: 0.75, blue: 0.43, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: x, y: 0, width: width, height: bounds.height), xRadius: 3.5, yRadius: 3.5).fill()
        NSGraphicsContext.restoreGraphicsState()
    }
    func startAnimation(_ sender: Any?) {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.phase = (self.phase + 0.012).truncatingRemainder(dividingBy: 1)
            self.needsDisplay = true
        }
    }
    func stopAnimation(_ sender: Any?) { timer?.invalidate(); timer = nil }
    deinit { timer?.invalidate() }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
    WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var overlay: NSView!
    private let heading = NSTextField(labelWithString: "MediaShare")
    private let status = NSTextField(wrappingLabelWithString: "Checking for updates…")
    private let detail = NSTextField(wrappingLabelWithString: "Getting MediaShare ready.")
    private let progress = GoldProgressIndicator()
    private var retryButton: NSButton!
    private var browserButton: NSButton!
    private var progressObservation: NSKeyValueObservation?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var downloadDestinations: [ObjectIdentifier: WKDownloadDestination] = [:]
    private var loadingPage = false
    private var checkingUpdate = true
    private var smokeFinished = false
    private let smokeTest = CommandLine.arguments.contains("--smoke-test")

    private struct WKDownloadDestination {
        let temporary: URL
        let selected: URL
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        if let icon = originalIcon() { NSApp.applicationIconImage = icon }
        buildMenus()
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if smokeTest {
            checkingUpdate = false
            showStatus("Testing native shell…", explanation: "No service data or uploads are accessed.", fraction: nil)
            loadingPage = true
            webView.loadHTMLString("<!doctype html><html><body style='background:#13100e;color:#fff'><p id='smoke'>MediaShare native smoke test</p></body></html>", baseURL: URL(string: "about:blank"))
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                self?.finishSmoke(false, message: "WKWebView did not finish the inert page within 30 seconds")
            }
            return
        }
        checkAtLaunch()
    }

    private func originalIcon() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "MediaShare", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }

    private func buildMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "MediaShare")
        appMenu.addItem(withTitle: "About MediaShare", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(explainUpdates), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide MediaShare", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit MediaShare", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload MediaShare…", action: #selector(confirmReload), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
        viewItem.submenu = view
        main.addItem(viewItem)
        NSApp.mainMenu = main
        // These are AppDelegate actions, rather than WebKit responder actions.
        for menu in [appMenu, view] {
            for item in menu.items {
                if let action = item.action, [#selector(showAbout), #selector(explainUpdates), #selector(confirmReload), #selector(openInBrowser)].contains(action) {
                    item.target = self
                }
            }
        }
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "MediaShare"
        window.minSize = NSSize(width: 440, height: 560)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("MediaShareMainWindow")
        let content = NSView()
        window.contentView = content

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default() // Preserve Firebase anonymous identity and accepted-drop recovery.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        installBrandScript(configuration.userContentController)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        // WKWebView retains its native HTML file-input and drag/drop behavior.
        // No JavaScript-to-native bridge is registered.
        buildOverlay(in: content)
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
            DispatchQueue.main.async {
                guard let self = self, self.loadingPage, !self.checkingUpdate else { return }
                self.progress.isIndeterminate = false
                self.progress.stopAnimation(nil)
                self.progress.doubleValue = view.estimatedProgress * 100
            }
        }
    }

    private func installBrandScript(_ controller: WKUserContentController) {
        guard let url = Bundle.main.url(forResource: "MediaShare", withExtension: "png"),
              let bytes = try? Data(contentsOf: url) else { return }
        let dataURL = "data:image/png;base64," + bytes.base64EncodedString()
        // Only replace the known brand image/favicon, never a slide or photo.
        let script = """
        (() => {
          if (location.origin !== 'https://firstupc.github.io' || !/^\\/media(?:\\/|$)/.test(location.pathname)) return;
          const image = document.querySelector('.brand img.mark, .mark img');
          if (image) image.src = '\(dataURL)';
          let icon = document.querySelector('link[rel="icon"]');
          if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
          icon.href = '\(dataURL)';
        })();
        """
        controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    private func buildOverlay(in content: NSView) {
        overlay = NSView()
        overlay.wantsLayer = true
        overlay.layer?.backgroundColor = NSColor(calibratedRed: 0.075, green: 0.063, blue: 0.055, alpha: 1).cgColor
        overlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: content.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        let icon = NSImageView()
        icon.image = originalIcon()
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 112).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 112).isActive = true
        heading.font = .systemFont(ofSize: 30, weight: .semibold)
        heading.textColor = NSColor(calibratedRed: 0.94, green: 0.84, blue: 0.62, alpha: 1)
        heading.alignment = .center
        status.font = .systemFont(ofSize: 15, weight: .medium)
        status.alignment = .center
        status.textColor = .labelColor
        detail.font = .systemFont(ofSize: 12)
        detail.alignment = .center
        detail.textColor = .secondaryLabelColor
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.widthAnchor.constraint(equalToConstant: 300).isActive = true
        retryButton = NSButton(title: "Retry", target: self, action: #selector(retryLoading))
        retryButton.bezelStyle = .rounded
        browserButton = NSButton(title: "Open in Browser", target: self, action: #selector(openInBrowser))
        browserButton.bezelStyle = .rounded
        let buttons = NSStackView(views: [retryButton, browserButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        let stack = NSStackView(views: [icon, heading, status, progress, detail, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 400),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -24),
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 360)
        ])
        retryButton.isHidden = true
        browserButton.isHidden = true
    }

    private func showStatus(_ text: String, explanation: String, fraction: Double?) {
        overlay.isHidden = false
        status.stringValue = text
        detail.stringValue = explanation
        retryButton.isHidden = true
        browserButton.isHidden = true
        progress.isHidden = false
        if let fraction = fraction {
            progress.isIndeterminate = false
            progress.stopAnimation(nil)
            progress.doubleValue = min(100, max(0, fraction * 100))
        } else {
            progress.isIndeterminate = true
            progress.startAnimation(nil)
        }
    }

    private func checkAtLaunch() {
        checkingUpdate = true
        showStatus("Checking for updates…", explanation: "The latest MediaShare page will open when the app is ready.", fraction: nil)
        Updater.check(progress: { [weak self] message, fraction in
            self?.showStatus(message, explanation: "Updating before uploads begin.", fraction: fraction)
        }, completion: { [weak self] result in
            guard let self = self else { return }
            self.checkingUpdate = false
            switch result {
            case .success(let staged):
                guard let staged = staged else { self.loadMediaShare(); return }
                self.showStatus("Installing update…", explanation: "MediaShare will close and reopen automatically.", fraction: 1)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    do {
                        try Updater.installAndRelaunch(staged: staged)
                        NSApp.terminate(nil)
                    } catch {
                        self.showUpdateProblem(error)
                    }
                }
            case .failure(let error):
                if (error as? UpdateError)?.requiresUserAction == true {
                    self.showUpdateProblem(error)
                } else {
                    // An unavailable release service must not prevent normal use.
                    self.loadMediaShare()
                }
            }
        })
    }

    private func showUpdateProblem(_ error: Error) {
        showStatus("The app update needs attention", explanation: "You can continue to the current MediaShare website.", fraction: 1)
        progress.isHidden = true
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "MediaShare couldn’t finish the update"
        alert.informativeText = error.localizedDescription + "\n\nContinue opens the current MediaShare website."
        alert.addButton(withTitle: "Continue")
        alert.beginSheetModal(for: window) { [weak self] _ in self?.loadMediaShare() }
    }

    private func loadMediaShare() {
        loadingPage = true
        showStatus("Opening MediaShare…", explanation: "Connecting to your current MediaShare page.", fraction: 0)
        let request = URLRequest(url: mediaURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45)
        webView.load(request)
    }

    @objc private func retryLoading() { loadMediaShare() }
    @objc private func openInBrowser() { NSWorkspace.shared.open(mediaURL) }

    @objc private func confirmReload() {
        guard !checkingUpdate else { return }
        let alert = NSAlert()
        alert.messageText = "Reload MediaShare?"
        alert.informativeText = "Finish any upload or unsaved edits first. Reloading opens the latest page."
        alert.addButton(withTitle: "Reload")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.loadMediaShare() }
        }
    }

    @objc private func explainUpdates() {
        let alert = NSAlert()
        alert.messageText = "Updates are checked when MediaShare opens"
        alert.informativeText = "Finish your uploads, then quit and reopen MediaShare to check for an app update. The latest website is loaded each time the app opens."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "MediaShare",
            .applicationIcon: originalIcon() ?? NSApp.applicationIconImage ?? NSImage(size: NSSize(width: 128, height: 128)),
            .credits: NSAttributedString(string: "FirstUPCJax\nThe current MediaShare website, with native uploads and downloads.")
        ])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if smokeTest && url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if navigationAction.shouldPerformDownload && MediaNavigation.isDownloadURL(url) && MediaNavigation.isOfficial(webView.url) {
            decisionHandler(.download); return
        }
        if MediaNavigation.isOfficial(url) { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated, let url = url,
           ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame && !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if MediaNavigation.isOfficial(url) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        } else if navigationAction.navigationType == .linkActivated,
                  ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadingPage = false
        progress.stopAnimation(nil)
        if smokeTest {
            webView.evaluateJavaScript("document.getElementById('smoke').textContent") { [weak self] result, error in
                guard let self = self else { return }
                let passed = error == nil && (result as? String) == "MediaShare native smoke test" &&
                    self.webView.configuration.websiteDataStore.isPersistent &&
                    NSApp.mainMenu?.items.count == 3 && self.originalIcon() != nil &&
                    MediaNavigation.isOfficial(mediaURL) &&
                    !MediaNavigation.isOfficial(URL(string: "https://firstupc.github.io/media-evil/")) &&
                    !MediaNavigation.isOfficial(URL(string: "https://firstupc.github.io.attacker.example/media/"))
                self.finishSmoke(passed, message: "Native window, persistent WKWebView, inert JavaScript, icon, menus, and navigation policy")
            }
            return
        }
        overlay.isHidden = true
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pageFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageFailed(NSError(domain: "MediaShare", code: 1, userInfo: [NSLocalizedDescriptionKey: "The page needs to be reopened."]))
    }

    private func pageFailed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if smokeTest { finishSmoke(false, message: error.localizedDescription); return }
        loadingPage = false
        showStatus("MediaShare couldn’t open", explanation: "Check your connection, then try again. You can also open MediaShare in your browser.", fraction: nil)
        progress.stopAnimation(nil)
        progress.isHidden = true
        retryButton.isHidden = false
        browserButton.isHidden = false
    }

    // Native file chooser for HTML <input type=file>. Drag/drop remains WebKit's
    // default implementation, so selected bytes go straight to the same webpage.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard MediaNavigation.isOfficial(webView.url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.jpeg, .png, .webP, .gif]
        panel.prompt = "Choose Slide"
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "MediaShare"; alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "MediaShare"; alert.informativeText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = "MediaShare"; alert.informativeText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        keepDownload(download)
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        keepDownload(download)
    }
    private func keepDownload(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        let safeName = (suggestedFilename as NSString).lastPathComponent
        panel.nameFieldStringValue = safeName.isEmpty ? "MediaShare-image" : safeName
        panel.canCreateDirectories = true
        panel.title = "Save MediaShare Image"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let selected = panel.url else {
                completionHandler(nil)
                return
            }
            // WebKit requires a nonexistent download path. Stage alongside the
            // chosen file so a failed transfer never damages an existing image,
            // and a confirmed replacement can finish atomically on this volume.
            let temporary = selected.deletingLastPathComponent()
                .appendingPathComponent(".MediaShare-\(UUID().uuidString).download")
            self.downloadDestinations[ObjectIdentifier(download)] = WKDownloadDestination(temporary: temporary, selected: selected)
            completionHandler(temporary)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let identifier = ObjectIdentifier(download)
        downloads.removeValue(forKey: identifier)
        guard let destination = downloadDestinations.removeValue(forKey: identifier) else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.selected.path) {
                _ = try FileManager.default.replaceItemAt(destination.selected, withItemAt: destination.temporary)
            } else {
                try FileManager.default.moveItem(at: destination.temporary, to: destination.selected)
            }
        } catch {
            try? FileManager.default.removeItem(at: destination.temporary)
            showDownloadFailure(error)
        }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let identifier = ObjectIdentifier(download)
        downloads.removeValue(forKey: identifier)
        if let destination = downloadDestinations.removeValue(forKey: identifier) {
            try? FileManager.default.removeItem(at: destination.temporary)
        }
        if (error as NSError).code == NSURLErrorCancelled { return }
        showDownloadFailure(error)
    }

    private func showDownloadFailure(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "The image couldn’t be saved"
        alert.informativeText = "Try downloading it again. " + error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    private func finishSmoke(_ passed: Bool, message: String) {
        guard !smokeFinished else { return }
        smokeFinished = true
        let finish: (Bool, String) -> Void = { success, explanation in
            print("MediaShare smoke test: \(success ? "PASS" : "FAIL") — \(explanation)")
            fflush(stdout)
            exit(success ? 0 : 1)
        }
        guard let path = ProcessInfo.processInfo.environment["MEDIASHARE_SMOKE_SCREENSHOT"], !path.isEmpty else {
            finish(passed, message)
            return
        }
        // This is an inert local page with the native status panel over it.
        // The optional CI artifact never includes uploads or service records.
        showStatus("MediaShare is ready", explanation: "Native shell check complete. No service data was accessed.", fraction: 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            do {
                guard let content = self.window.contentView else {
                    throw NSError(domain: "MediaShareSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: "The native window has no content view."])
                }
                content.layoutSubtreeIfNeeded()
                self.window.displayIfNeeded()
                guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
                    throw NSError(domain: "MediaShareSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: "The native panel could not be captured."])
                }
                content.cacheDisplay(in: content.bounds, to: bitmap)
                guard let png = bitmap.representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "MediaShareSmoke", code: 3, userInfo: [NSLocalizedDescriptionKey: "The native panel could not be encoded as PNG."])
                }
                let destination = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                try png.write(to: destination, options: .atomic)
                finish(passed, message + "; native panel PNG saved")
            } catch {
                finish(false, message + "; screenshot failed: " + error.localizedDescription)
            }
        }
    }
}

if Updater.runHelperIfNeeded() {
    exit(0)
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
private let delegate = AppDelegate()
application.delegate = delegate
application.run()
