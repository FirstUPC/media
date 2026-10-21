import Foundation

@main
struct UpdatePolicyTests {
    static var count = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        guard try value() else { throw UpdateError("Test failed: " + message) }
        count += 1
    }
    static func rejected(_ message: String, _ action: () throws -> Void) throws {
        do { try action() } catch { count += 1; return }
        throw UpdateError("Expected rejection: " + message)
    }
    static func release(_ build: String, draft: Bool = false, prerelease: Bool = false) -> [String: Any] {
        let tag = "macos-" + build
        return ["tag_name": tag, "draft": draft, "prerelease": prerelease, "assets": [
            ["name": "MediaShare-macOS.zip", "size": 400,
             "browser_download_url": "https://github.com/FirstUPC/media/releases/download/\(tag)/MediaShare-macOS.zip"],
            ["name": "MediaShare-macOS.zip.sha256", "size": 85,
             "browser_download_url": "https://github.com/FirstUPC/media/releases/download/\(tag)/MediaShare-macOS.zip.sha256"]]]
    }
    static func json(_ releases: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(withJSONObject: releases)
    }
    static func main() throws {
        let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
        try check(UpdatePolicy.buildNumber("20261021013000") == 20261021013000, "numeric version")
        for value in ["", "-2", "1.2", "0", "18446744073709551616"] {
            try rejected("invalid version") { _ = try UpdatePolicy.buildNumber(value) }
        }
        let releases = [release("20261021013000"), release("20261021023000", draft: true),
                        release("20261021033000", prerelease: true), release("20261020000000")]
        try check(UpdatePolicy.newestRelease(data: json(releases), currentBuild: 2)?.build == 20261021013000, "latest public stable native release")
        try check(UpdatePolicy.newestRelease(data: json(releases), currentBuild: 20261021013000) == nil, "no reinstall or downgrade")
        var bad = release("20261021013000")
        bad["assets"] = []
        try rejected("missing asset") { _ = try UpdatePolicy.newestRelease(data: json([bad]), currentBuild: 2) }
        try rejected("wrong repository") { _ = try UpdatePolicy.assetURL("https://github.com/Other/media/releases/download/macos-20261021013000/MediaShare-macOS.zip", tag: "macos-20261021013000", name: UpdatePolicy.archiveName) }
        try check(UpdatePolicy.allowsRedirect(URL(string: "https://release-assets.githubusercontent.com/file")!), "GitHub asset redirect")
        for text in ["http://github.com/file", "https://github.com.evil.test/file", "https://user@github.com/file", "https://github.com:444/file", "file:///tmp/file"] {
            try check(!UpdatePolicy.allowsRedirect(URL(string: text)!), "reject untrusted redirect")
        }
        let digest = String(repeating: "a", count: 64)
        try check(UpdatePolicy.checksum(Data((digest + "  MediaShare-macOS.zip\n").utf8)) == digest, "checksum record")
        for text in [digest, digest + "  Other.zip", digest + "  MediaShare-macOS.zip\nextra", "wrong  MediaShare-macOS.zip"] {
            try rejected("invalid checksum") { _ = try UpdatePolicy.checksum(Data(text.utf8)) }
        }
        try UpdatePolicy.validateArchive(Data(contentsOf: fixture.appendingPathComponent("valid.zip"))); count += 1
        for name in ["traversal", "wrong-root", "symlink", "unicode-alias", "duplicate", "local-mismatch", "encrypted", "oversize", "crc-mismatch"] {
            try rejected(name) { try UpdatePolicy.validateArchive(Data(contentsOf: fixture.appendingPathComponent(name + ".zip"))) }
        }
        let valid = try Data(contentsOf: fixture.appendingPathComponent("valid.zip"))
        for length in [0, 1, 21, 31, valid.count - 1] {
            try rejected("truncated ZIP") { try UpdatePolicy.validateArchive(Data(valid.prefix(length))) }
        }
        let fm = FileManager.default
        for failure in ["none", "verify", "launch"] {
            let temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try fm.createDirectory(at: temp, withIntermediateDirectories: false)
            defer { try? fm.removeItem(at: temp) }
            let target = temp.appendingPathComponent("MediaShare.app"), staged = temp.appendingPathComponent("new.app")
            try fm.createDirectory(at: target, withIntermediateDirectories: false)
            try fm.createDirectory(at: staged, withIntermediateDirectories: false)
            try Data("old".utf8).write(to: target.appendingPathComponent("marker"))
            try Data("new".utf8).write(to: staged.appendingPathComponent("marker"))
            let action = {
                try UpdateFileInstaller.replace(staged: staged, target: target,
                    verify: { url in
                        try check(String(contentsOf: url.appendingPathComponent("marker")) == "new", "new app verified after atomic exchange")
                        if failure == "verify" { throw UpdateError("simulated verification failure") }
                    }, launch: { _ in if failure == "launch" { throw UpdateError("simulated launch failure") } })
            }
            if failure == "none" {
                try action()
                try check(String(contentsOf: target.appendingPathComponent("marker")) == "new", "new app installed")
                try check(!fm.fileExists(atPath: staged.path), "old staging copy removed after success")
            } else {
                try rejected("installer rollback") { try action() }
                try check(String(contentsOf: target.appendingPathComponent("marker")) == "old", "previous app restored")
                try check(String(contentsOf: staged.appendingPathComponent("marker")) == "new", "failed update retained safely")
            }
        }
        print("PASS: \(count) updater policy, archive, and atomic rollback assertions")
    }
}
