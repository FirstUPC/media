import Cocoa
import CryptoKit
import Darwin
import Foundation

private final class UpdateDownload: NSObject, URLSessionDataDelegate {
    private let limit: Int
    private let progress: ((Double?) -> Void)?
    private let timeout: TimeInterval
    private var data = Data()
    private var failure: Error?
    private var expected: Int64 = -1
    private let finished = DispatchSemaphore(value: 0)
    init(limit: Int, timeout: TimeInterval = 12, progress: ((Double?) -> Void)? = nil) {
        self.limit = limit; self.timeout = timeout; self.progress = progress
    }
    func fetch(_ url: URL) throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = min(30, timeout)
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue("MediaShare-macOS-Updater", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        session.dataTask(with: request).resume()
        guard finished.wait(timeout: .now() + timeout + 2) == .success else {
            session.invalidateAndCancel()
            throw UpdateError("The update check timed out. Your installed app is unchanged.")
        }
        session.finishTasksAndInvalidate()
        if let error = failure { throw error }
        return data
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let url = response.url, UpdatePolicy.allowsRedirect(url),
              response.expectedContentLength <= limit else {
            failure = UpdateError("GitHub could not provide a valid update download. Your installed app is unchanged.")
            completionHandler(.cancel); return
        }
        expected = response.expectedContentLength
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard data.count + chunk.count <= limit else {
            failure = UpdateError("The update download exceeds the allowed size.")
            dataTask.cancel(); return
        }
        data.append(chunk)
        progress?(expected > 0 ? min(1, Double(data.count) / Double(expected)) : nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        failure = failure ?? error
        finished.signal()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, UpdatePolicy.allowsRedirect(url) else {
            failure = UpdateError("GitHub redirected the update to an untrusted location.")
            completionHandler(nil); return
        }
        completionHandler(request)
    }
}

enum Updater {
    private static let fm = FileManager.default
    private static let stateLock = NSLock()
    private static var checking = false

    static func check(progress: @escaping (String, Double?) -> Void,
                      completion: @escaping (Result<URL?, Error>) -> Void) {
        stateLock.lock()
        guard !checking else {
            stateLock.unlock()
            DispatchQueue.main.async { completion(.failure(UpdateError("An update check is already running."))) }
            return
        }
        checking = true; stateLock.unlock()
        func report(_ message: String, _ amount: Double? = nil) {
            DispatchQueue.main.async { progress(message, amount) }
        }
        DispatchQueue.global(qos: .utility).async {
            let result: Result<URL?, Error>
            do {
                if let previousError = UserDefaults.standard.string(forKey: "MediaShareLastUpdateError") {
                    UserDefaults.standard.removeObject(forKey: "MediaShareLastUpdateError")
                    throw UpdateError(previousError, requiresUserAction: true)
                } else if ProcessInfo.processInfo.arguments.contains("--skip-update-once") {
                    result = .success(nil)
                } else {
                    result = .success(try prepare(report: report))
                }
            } catch { result = .failure(error) }
            stateLock.lock(); checking = false; stateLock.unlock()
            DispatchQueue.main.async { completion(result) }
        }
    }

    private static func prepare(report: @escaping (String, Double?) -> Void) throws -> URL? {
        report("Checking for MediaShare updates…", nil)
        let current = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
        let version = try UpdatePolicy.buildNumber(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")
        let releases = try UpdateDownload(limit: 2 * 1024 * 1024).fetch(
            URL(string: "https://api.github.com/repos/FirstUPC/media/releases?per_page=100")!)
        guard let release = try UpdatePolicy.newestRelease(data: releases, currentBuild: version) else { return nil }
        try requireWritableInstallation(current)
        let parent = current.deletingLastPathComponent()
        let stage = parent.appendingPathComponent(".MediaShare-update-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false,
                               attributes: [.posixPermissions: 0o700])
        do {
            report("Downloading MediaShare update…", 0)
            let wanted = try UpdatePolicy.checksum(UpdateDownload(limit: 1024).fetch(release.checksumURL))
            let archive = try UpdateDownload(limit: release.size, timeout: 180, progress: { value in
                report("Downloading MediaShare update…", value)
            }).fetch(release.archiveURL)
            guard archive.count == release.size, digest(archive) == wanted else {
                throw UpdateError("The update checksum did not match. Nothing was installed.")
            }
            report("Verifying update…", nil)
            try UpdatePolicy.validateArchive(archive)
            let archiveURL = stage.appendingPathComponent(UpdatePolicy.archiveName)
            try archive.write(to: archiveURL, options: .atomic)
            let extracted = stage.appendingPathComponent("extracted", isDirectory: true)
            try fm.createDirectory(at: extracted, withIntermediateDirectories: false)
            try run("/usr/bin/ditto", ["-x", "-k", archiveURL.path, extracted.path])
            let staged = extracted.appendingPathComponent("MediaShare.app", isDirectory: true)
            try validateBundle(staged, expectedBuild: release.build)
            try fm.removeItem(at: archiveURL)
            report("Installing update and restarting MediaShare…", 1)
            return staged
        } catch {
            try? fm.removeItem(at: stage)
            throw error
        }
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func requireWritableInstallation(_ target: URL) throws {
        guard target.pathExtension == "app",
              !target.path.contains("/AppTranslocation/"),
              fm.isWritableFile(atPath: target.deletingLastPathComponent().path),
              fm.isWritableFile(atPath: target.path) else {
            throw UpdateError("To install updates, move MediaShare to your Applications folder (~/Applications), then reopen it. This copy was not changed.", requiresUserAction: true)
        }
    }

    private static func info(_ app: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else {
            throw UpdateError("The update has no valid application information.")
        }
        return value
    }

    private static func validateBundle(_ app: URL, expectedBuild: UInt64) throws {
        let metadata = try info(app)
        guard metadata["CFBundleIdentifier"] as? String == UpdatePolicy.bundleIdentifier,
              metadata["CFBundleExecutable"] as? String == "MediaShare",
              metadata["CFBundlePackageType"] as? String == "APPL",
              try UpdatePolicy.buildNumber(metadata["CFBundleVersion"] as? String ?? "") == expectedBuild else {
            throw UpdateError("The downloaded app does not match the expected MediaShare release.")
        }
        if let minimum = metadata["LSMinimumSystemVersion"] as? String {
            let parts = minimum.split(separator: ".").compactMap { Int($0) }
            guard !parts.isEmpty, parts.count <= 3,
                  ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(
                    majorVersion: parts[0], minorVersion: parts.count > 1 ? parts[1] : 0,
                    patchVersion: parts.count > 2 ? parts[2] : 0)) else {
                throw UpdateError("The new MediaShare version requires a newer macOS release.")
            }
        }
        guard let entries = fm.enumerator(at: app, includingPropertiesForKeys: [.isSymbolicLinkKey], options: []) else {
            throw UpdateError("The staged update cannot be inspected.")
        }
        var expandedBytes: UInt64 = 0
        for case let url as URL in entries {
            let attributes = try fm.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular || attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw UpdateError("The update contains an unsupported filesystem entry.")
            }
            expandedBytes += (attributes[.size] as? NSNumber)?.uint64Value ?? 0
            guard expandedBytes <= UpdatePolicy.maxExpandedBytes else {
                throw UpdateError("The expanded update exceeds the allowed size.")
            }
        }
        for (name, expected) in UpdatePolicy.iconHashes {
            let actual = try Data(contentsOf: app.appendingPathComponent("Contents/Resources/" + name))
            guard digest(actual) == expected else { throw UpdateError("The update does not preserve the original MediaShare logo.") }
        }
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        guard fm.isExecutableFile(atPath: app.appendingPathComponent("Contents/MacOS/MediaShare").path) else {
            throw UpdateError("The updated MediaShare executable cannot be run.")
        }
    }

    static func installAndRelaunch(staged: URL) throws {
        let target = Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
        try requireWritableInstallation(target)
        let stageRoot = try validatedStageRoot(staged, target: target)
        let metadata = try info(staged)
        let build = try UpdatePolicy.buildNumber(metadata["CFBundleVersion"] as? String ?? "")
        try validateBundle(staged, expectedBuild: build)
        let ready = stageRoot.appendingPathComponent("helper-ready")
        guard let executable = Bundle.main.executableURL else { throw UpdateError("The updater helper could not be located.") }
        let helper = Process()
        helper.executableURL = executable
        helper.arguments = ["--install-update", target.path, staged.path, String(getpid()), String(build)]
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        try helper.run()
        let deadline = Date().addingTimeInterval(5)
        while !fm.fileExists(atPath: ready.path), helper.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.025)
        }
        guard fm.fileExists(atPath: ready.path), helper.isRunning else {
            if helper.isRunning { helper.terminate() }
            throw UpdateError("The install helper could not start. Your existing app is unchanged.")
        }
        NSApplication.shared.terminate(nil)
    }

    private static func validatedStageRoot(_ staged: URL, target: URL) throws -> URL {
        let canonical = staged.standardizedFileURL.resolvingSymlinksInPath()
        let root = canonical.deletingLastPathComponent().deletingLastPathComponent()
        guard canonical.path == staged.path, canonical.lastPathComponent == "MediaShare.app",
              canonical.deletingLastPathComponent().lastPathComponent == "extracted",
              root.lastPathComponent.range(of: "^\\.MediaShare-update-[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil,
              root.deletingLastPathComponent() == target.deletingLastPathComponent() else {
            throw UpdateError("The staged update is not beside this installed application.")
        }
        return root
    }

    static func runHelperIfNeeded() -> Bool {
        let args = ProcessInfo.processInfo.arguments
        guard args.count > 1, args[1] == "--install-update" else { return false }
        var recoveryTarget: URL?
        var parentExited = false
        do {
            guard args.count == 6, let parentPID = Int32(args[4]), parentPID > 1,
                  getppid() == parentPID else { throw UpdateError("The install helper was not started by MediaShare.") }
            let target = URL(fileURLWithPath: args[2]).standardizedFileURL.resolvingSymlinksInPath()
            let staged = URL(fileURLWithPath: args[3])
            guard target == Bundle.main.bundleURL.standardizedFileURL.resolvingSymlinksInPath() else {
                throw UpdateError("The helper target is not its own application.")
            }
            recoveryTarget = target
            let root = try validatedStageRoot(staged, target: target)
            let build = try UpdatePolicy.buildNumber(args[5])
            try requireWritableInstallation(target)
            try validateBundle(staged, expectedBuild: build)
            try Data("ready".utf8).write(to: root.appendingPathComponent("helper-ready"), options: .atomic)
            let deadline = Date().addingTimeInterval(30)
            while kill(parentPID, 0) == 0 || errno == EPERM {
                guard Date() < deadline else { throw UpdateError("MediaShare did not quit; the update was not installed.") }
                Thread.sleep(forTimeInterval: 0.1)
            }
            parentExited = true
            let lockPath = target.deletingLastPathComponent().appendingPathComponent(".MediaShare-install.lock").path
            let fd = Darwin.open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw UpdateError("The update installation lock could not be opened.") }
            defer { flock(fd, LOCK_UN); close(fd) }
            guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw UpdateError("Another MediaShare update is installing.") }
            let currentBuild = try UpdatePolicy.buildNumber(info(target)["CFBundleVersion"] as? String ?? "")
            guard build > currentBuild else {
                try? fm.removeItem(at: root)
                try run("/usr/bin/open", [target.path, "--args", "--skip-update-once"])
                return true
            }
            try UpdateFileInstaller.replace(staged: staged, target: target,
                verify: { try validateBundle($0, expectedBuild: build) },
                launch: { try run("/usr/bin/open", ["-n", $0.path, "--args", "--skip-update-once"]) })
            try? fm.removeItem(at: root)
        } catch {
            log("Update helper: " + error.localizedDescription)
            if parentExited, let target = recoveryTarget, fm.fileExists(atPath: target.path) {
                UserDefaults.standard.set(error.localizedDescription, forKey: "MediaShareLastUpdateError")
                try? run("/usr/bin/open", ["-n", target.path, "--args", "--skip-update-once"])
            }
        }
        return true
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(30)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning {
            process.terminate()
            let grace = Date().addingTimeInterval(2)
            while process.isRunning, Date() < grace { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            throw UpdateError("The update timed out while running \(URL(fileURLWithPath: executable).lastPathComponent).")
        }
        guard process.terminationStatus == 0 else { throw UpdateError("The update could not complete \(URL(fileURLWithPath: executable).lastPathComponent).") }
    }

    private static func log(_ message: String) {
        let directory = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs", isDirectory: true)
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("MediaShare-updater.log")
        let data = Data((ISO8601DateFormatter().string(from: Date()) + " " + message + "\n").utf8)
        if !fm.fileExists(atPath: path.path) { try? data.write(to: path, options: .atomic); return }
        if let handle = try? FileHandle(forWritingTo: path) {
            defer { try? handle.close() }
            do { try handle.seekToEnd(); try handle.write(contentsOf: data) } catch {}
        }
    }
}
