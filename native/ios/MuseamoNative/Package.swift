// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MuseamoNative",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [.library(name: "MuseamoNative", targets: ["MuseamoNative"])],
    targets: [
        .binaryTarget(name: "MuseamoSyncCore", path: "Frameworks/MuseamoSyncCore.xcframework"),
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
        .target(name: "MuseamoNative", dependencies: ["CSQLite", "MuseamoSyncCore"], resources: [.process("PrivacyInfo.xcprivacy")]),
        .testTarget(name: "MuseamoNativeTests", dependencies: ["MuseamoNative"], resources: [.copy("Fixtures")])
    ]
)
