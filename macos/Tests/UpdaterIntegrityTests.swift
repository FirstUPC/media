import Foundation
import Darwin

@main
struct UpdaterIntegrityTests {
    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data(("FAIL: " + error.localizedDescription + "\n").utf8))
            exit(1)
        }
    }
    static func run() throws {
        let original = URL(fileURLWithPath: CommandLine.arguments[1])
        let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: original.appendingPathComponent("Contents/Info.plist")), options: [], format: nil) as! [String: Any]
        let build = try UpdatePolicy.buildNumber(metadata["CFBundleVersion"] as! String)
        try Updater.validateBundle(original, expectedBuild: build)
        var count = 1
        func mustReject(_ label: String, _ app: URL, expectedBuild: UInt64) throws {
            do { try Updater.validateBundle(app, expectedBuild: expectedBuild) }
            catch { count += 1; return }
            throw UpdateError("Integrity test failed to reject: " + label)
        }
        try mustReject("wrong release version", original, expectedBuild: build + 1)
        let fm = FileManager.default
        let temp = fm.temporaryDirectory.appendingPathComponent("MediaShare-integrity-" + UUID().uuidString)
        try fm.createDirectory(at: temp, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: temp) }
        for scenario in ["icon", "executable", "identifier", "symlink", "minimumOS"] {
            let copy = temp.appendingPathComponent(scenario + ".app")
            try fm.copyItem(at: original, to: copy)
            switch scenario {
            case "icon":
                try Data("changed".utf8).write(to: copy.appendingPathComponent("Contents/Resources/MediaShare.png"))
            case "executable":
                let executable = copy.appendingPathComponent("Contents/MacOS/MediaShare")
                var data = try Data(contentsOf: executable)
                data[data.count / 2] ^= 1
                try data.write(to: executable)
            case "symlink":
                try fm.createSymbolicLink(atPath: copy.appendingPathComponent("Contents/Resources/link").path, withDestinationPath: "/tmp")
            default:
                var changed = metadata
                if scenario == "identifier" { changed["CFBundleIdentifier"] = "org.other.application" }
                else { changed["LSMinimumSystemVersion"] = "99.0" }
                try PropertyListSerialization.data(fromPropertyList: changed, format: .xml, options: 0)
                    .write(to: copy.appendingPathComponent("Contents/Info.plist"))
            }
            try mustReject(scenario, copy, expectedBuild: build)
        }
        print("PASS: \(count) built-app identity, logo, signature and filesystem integrity assertions")
    }
}
