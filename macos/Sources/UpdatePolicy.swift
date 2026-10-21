import Foundation
import Darwin

struct UpdateError: LocalizedError {
    let message: String
    let requiresUserAction: Bool
    init(_ message: String, requiresUserAction: Bool = false) {
        self.message = message; self.requiresUserAction = requiresUserAction
    }
    var errorDescription: String? { message }
}

struct NativeRelease {
    let build: UInt64
    let tag: String
    let archiveURL: URL
    let checksumURL: URL
    let size: Int
}

enum UpdatePolicy {
    static let repository = "FirstUPC/media"
    static let bundleIdentifier = "org.firstupc.mediashare"
    static let archiveName = "MediaShare-macOS.zip"
    static let maxArchiveBytes = 100 * 1024 * 1024
    static let maxExpandedBytes = 250 * 1024 * 1024
    static let iconHashes = [
        "MediaShare.png": "458683cbfbdcd901763d19e37ac0b5432e399ea2ea56c0db253aa797409bacd5",
        "MediaShare.icns": "4adf3f3b026dfb8334bfdc4ab2f01e6984b8105452bba722a3e34c7c0fef1945"
    ]

    static func buildNumber(_ text: String) throws -> UInt64 {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = UInt64(text), number > 0 else {
            throw UpdateError("The application build number is invalid.")
        }
        return number
    }

    static func assetURL(_ text: String, tag: String, name: String) throws -> URL {
        let expected = "https://github.com/\(repository)/releases/download/\(tag)/\(name)"
        guard text == expected, let url = URL(string: text) else {
            throw UpdateError("The update asset is not in the official MediaShare release.")
        }
        return url
    }

    static func newestRelease(data: Data, currentBuild: UInt64) throws -> NativeRelease? {
        guard let releases = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw UpdateError("GitHub returned an invalid release list.")
        }
        let candidates: [(UInt64, [String: Any])] = releases.compactMap { release in
            guard release["draft"] as? Bool == false,
                  release["prerelease"] as? Bool == false,
                  let tag = release["tag_name"] as? String,
                  tag.range(of: "^macos-[0-9]{14}$", options: .regularExpression) != nil,
                  let build = try? buildNumber(String(tag.dropFirst(6))),
                  build > currentBuild else { return nil }
            return (build, release)
        }
        guard let (build, release) = candidates.max(by: { $0.0 < $1.0 }),
              let tag = release["tag_name"] as? String else { return nil }
        let assets = release["assets"] as? [[String: Any]] ?? []
        func asset(_ name: String) throws -> [String: Any] {
            let matches = assets.filter { $0["name"] as? String == name }
            guard matches.count == 1 else {
                throw UpdateError("The latest MediaShare release is missing a unique \(name) asset.")
            }
            return matches[0]
        }
        let archive = try asset(archiveName), checksum = try asset(archiveName + ".sha256")
        guard let size = archive["size"] as? Int, size > 0, size <= maxArchiveBytes,
              let checksumSize = checksum["size"] as? Int, checksumSize > 0, checksumSize < 1024 else {
            throw UpdateError("The update exceeds the allowed download size.")
        }
        return NativeRelease(build: build, tag: tag,
            archiveURL: try assetURL(archive["browser_download_url"] as? String ?? "", tag: tag, name: archiveName),
            checksumURL: try assetURL(checksum["browser_download_url"] as? String ?? "", tag: tag, name: archiveName + ".sha256"),
            size: size)
    }

    static func checksum(_ data: Data) throws -> String {
        guard let text = String(data: data, encoding: .utf8), text.utf8.count < 1024 else {
            throw UpdateError("The update checksum is invalid.")
        }
        let fields = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard fields.count == 2, String(fields[1]) == archiveName,
              fields[0].range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else {
            throw UpdateError("The update checksum does not describe the MediaShare archive.")
        }
        return fields[0].lowercased()
    }

    static func allowsRedirect(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443 else { return false }
        return ["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "")
    }

    // Validate the central directory and every corresponding local header
    // before giving an archive to ditto. This application needs no symlinks.
    static func validateArchive(_ data: Data) throws {
        func fail() -> UpdateError { UpdateError("The downloaded archive has an unsafe or unsupported layout.") }
        func u16(_ at: Int) throws -> Int {
            guard at >= 0, at + 2 <= data.count else { throw fail() }
            return Int(data[at]) | Int(data[at + 1]) << 8
        }
        func u32(_ at: Int) throws -> Int {
            return try u16(at) | (u16(at + 2) << 16)
        }
        func validateExtras(_ start: Int, _ length: Int) throws {
            var cursor = start
            guard start >= 0, start + length <= data.count else { throw fail() }
            while cursor < start + length {
                guard cursor + 4 <= start + length else { throw fail() }
                let kind = try u16(cursor), size = try u16(cursor + 2)
                // Only timestamps and Unix UID/GID metadata are needed by our
                // ZIP producer. In particular, reject Unicode filename aliases,
                // ZIP64, and extra fields with alternate filesystem semantics.
                guard [0x5455, 0x7875].contains(kind), cursor + 4 + size <= start + length else { throw fail() }
                cursor += 4 + size
            }
        }
        guard data.count >= 22, data.count <= maxArchiveBytes else { throw fail() }
        var end: Int?
        for offset in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if try u32(offset) == 0x06054b50,
               offset + 22 + (try u16(offset + 20)) == data.count { end = offset; break }
        }
        guard let end = end, try u16(end + 4) == 0, try u16(end + 6) == 0,
              try u16(end + 8) == u16(end + 10) else { throw fail() }
        let count = try u16(end + 10), directorySize = try u32(end + 12), directoryStart = try u32(end + 16)
        guard count > 0, count < 10000, directoryStart + directorySize == end else { throw fail() }
        var offset = directoryStart, total = 0
        var names = Set<String>(), ranges: [Range<Int>] = []
        for _ in 0..<count {
            guard try u32(offset) == 0x02014b50 else { throw fail() }
            let flags = try u16(offset + 8), compression = try u16(offset + 10)
            let compressed = try u32(offset + 20), expanded = try u32(offset + 24)
            let nameLength = try u16(offset + 28), extraLength = try u16(offset + 30), commentLength = try u16(offset + 32)
            let external = try u32(offset + 38), local = try u32(offset + 42)
            let next = offset + 46 + nameLength + extraLength + commentLength
            guard next <= end, nameLength > 0, flags & 1 == 0,
                  compression == 0 || compression == 8,
                  compressed < maxArchiveBytes, expanded <= maxExpandedBytes,
                  let name = String(data: data[(offset + 46)..<(offset + 46 + nameLength)], encoding: .utf8),
                  !name.contains("\\"), !name.contains("\0"), !name.hasPrefix("/"),
                  name == "MediaShare.app/" || name.hasPrefix("MediaShare.app/") else { throw fail() }
            try validateExtras(offset + 46 + nameLength, extraLength)
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            guard !parts.contains(".."), !parts.contains("."),
                  !parts.dropLast().contains(""), names.insert(name.lowercased()).inserted else { throw fail() }
            let kind = (external >> 16) & 0xf000
            guard kind == 0 || kind == 0x8000 || kind == 0x4000 else { throw fail() }
            guard (kind != 0x4000 || name.hasSuffix("/")),
                  try u32(local) == 0x04034b50,
                  try u16(local + 6) == flags, try u16(local + 8) == compression else { throw fail() }
            let localNameLength = try u16(local + 26), localExtraLength = try u16(local + 28)
            let bodyStart = local + 30 + localNameLength + localExtraLength
            guard localNameLength == nameLength, bodyStart + compressed <= directoryStart,
                  data[(local + 30)..<(local + 30 + localNameLength)] == data[(offset + 46)..<(offset + 46 + nameLength)] else { throw fail() }
            try validateExtras(local + 30 + localNameLength, localExtraLength)
            if flags & 8 == 0 {
                guard try u32(local + 14) == u32(offset + 16),
                      try u32(local + 18) == compressed, try u32(local + 22) == expanded else { throw fail() }
            }
            let occupied = local..<(bodyStart + compressed)
            guard !ranges.contains(where: { $0.overlaps(occupied) }) else { throw fail() }
            ranges.append(occupied)
            total += expanded
            guard total <= maxExpandedBytes else { throw fail() }
            offset = next
        }
        guard offset == end, names.contains("mediashare.app/contents/info.plist"),
              names.contains("mediashare.app/contents/macos/mediashare") else { throw fail() }
    }
}

enum UpdateFileInstaller {
    // Darwin exchanges both names atomically: even a crash cannot leave the
    // installed path absent. The previous app stays at the staging path until
    // validation and the relaunch request succeed.
    static func replace(staged: URL, target: URL,
                        verify: (URL) throws -> Void, launch: (URL) throws -> Void) throws {
        let fm = FileManager.default
        func swap() throws {
            guard renamex_np(staged.path, target.path, UInt32(RENAME_SWAP)) == 0 else {
                throw UpdateError("The application exchange failed: \(String(cString: strerror(errno))).")
            }
        }
        try swap()
        do {
            try verify(target)
            try launch(target)
        } catch {
            do { try swap() }
            catch { throw UpdateError("Update recovery needs attention. The previous app remains at \(staged.path).") }
            throw error
        }
        try? fm.removeItem(at: staged)
    }
}
