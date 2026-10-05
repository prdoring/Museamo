import Capacitor
import Foundation
import MuseamoNative
import UIKit

/// The WebView sees typed library operations, never database paths or native keys.
@objc(MuseamoPlugin)
public final class MuseamoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MuseamoPlugin"
    public let jsName = "Museamo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "library", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryEntries", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEntry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateEntry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCompleted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteEntry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreEntry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveTag", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteTag", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveProfile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listRecovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreRecovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearRecovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAllRecovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyFormatted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]
    private let repositoryQueue = DispatchQueue(label: "com.prdoring.museamo.library", qos: .userInitiated)
    private var repository: LibraryStore?
    private var activeObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private static let mutations: Set<String> = [
        "commitDraft", "updateEntry", "setStar", "setCompleted", "deleteEntry", "restoreEntry", "saveTag", "deleteTag", "saveProfile", "restoreRecovery", "clearRecovery", "clearAllRecovery"
    ]

    public override func load() {
        activeObserver = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("dataChanged", data: [:])
        }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.finishPendingWrites()
        }
    }

    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }

    private func store() throws -> LibraryStore {
        if let repository { return repository }
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Museamo", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = try LibraryStore(databaseURL: directory.appendingPathComponent("library.sqlite"))
        repository = store
        return store
    }

    private func execute(_ method: String, _ call: CAPPluginCall) {
        guard let input = call.options as? [String: Any] else {
            call.reject("Invalid library request.", "INVALID_INPUT")
            return
        }
        repositoryQueue.async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.store().execute(method: method, input: input)
                DispatchQueue.main.async {
                    call.resolve(result)
                    if Self.mutations.contains(method) { self.notifyListeners("dataChanged", data: [:]) }
                }
            } catch {
                DispatchQueue.main.async { call.reject(error.localizedDescription, "LIBRARY_ERROR", error) }
            }
        }
    }

    /// Give already queued durable writes time to finish before suspension.
    private func finishPendingWrites() {
        var task = UIBackgroundTaskIdentifier.invalid
        let finish = {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "Save thoughts", expirationHandler: finish)
        repositoryQueue.async { DispatchQueue.main.async(execute: finish) }
    }

    @objc func library(_ call: CAPPluginCall) { execute("library", call) }
    @objc func queryEntries(_ call: CAPPluginCall) { execute("queryEntries", call) }
    @objc func getEntry(_ call: CAPPluginCall) { execute("getEntry", call) }
    @objc func getDraft(_ call: CAPPluginCall) { execute("getDraft", call) }
    @objc func updateDraft(_ call: CAPPluginCall) { execute("updateDraft", call) }
    @objc func discardDraft(_ call: CAPPluginCall) { execute("discardDraft", call) }
    @objc func commitDraft(_ call: CAPPluginCall) { execute("commitDraft", call) }
    @objc func updateEntry(_ call: CAPPluginCall) { execute("updateEntry", call) }
    @objc func setStar(_ call: CAPPluginCall) { execute("setStar", call) }
    @objc func setCompleted(_ call: CAPPluginCall) { execute("setCompleted", call) }
    @objc func deleteEntry(_ call: CAPPluginCall) { execute("deleteEntry", call) }
    @objc func restoreEntry(_ call: CAPPluginCall) { execute("restoreEntry", call) }
    @objc func saveTag(_ call: CAPPluginCall) { execute("saveTag", call) }
    @objc func deleteTag(_ call: CAPPluginCall) { execute("deleteTag", call) }
    @objc func saveProfile(_ call: CAPPluginCall) { execute("saveProfile", call) }
    @objc func listRecovery(_ call: CAPPluginCall) { execute("listRecovery", call) }
    @objc func restoreRecovery(_ call: CAPPluginCall) { execute("restoreRecovery", call) }
    @objc func clearRecovery(_ call: CAPPluginCall) { execute("clearRecovery", call) }
    @objc func clearAllRecovery(_ call: CAPPluginCall) { execute("clearAllRecovery", call) }

    @objc func copyFormatted(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), let html = call.getString("html") else {
            call.reject("Text and formatted text are required.")
            return
        }
        DispatchQueue.main.async {
            UIPasteboard.general.setItems([["public.utf8-plain-text": text, "public.html": Data(html.utf8)]], options: [.localOnly: true])
            call.resolve()
        }
    }

    @objc func openExternal(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), ["https", "http", "mailto", "tel"].contains(scheme) else {
            call.reject("This link cannot be opened.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("No app could open this link.") }
            }
        }
    }
}
