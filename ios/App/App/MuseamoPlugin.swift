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
        CAPPluginMethod(name: "getSyncState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "linkDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptEnrollment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncNow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTagShareState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTagSharing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createTagInvite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelTagInvite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previewTagInvite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "joinTagShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeTagShareMember", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "leaveTagShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTagSharing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncTagShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanTagInvite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseDeleted", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "locationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLocationEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise)
    ]
    private let repositoryQueue = DispatchQueue(label: "com.prdoring.museamo.library", qos: .userInitiated)
    private var repository: LibraryStore?
    private let runtimeQueue = DispatchQueue(label: "com.prdoring.museamo.sync", qos: .userInitiated)
    private var runtime: NativeSyncRuntime?
    private var foreground = true
    private var generation = 0
    private var discoveryAvailable = false
    private var discoveryError: String?
    private let discovery = AppleDiscovery()
    private let location = ManualLocation()
    private var scanner: InvitationScanner?
    private var picker: OriginalPicker?
    private var polling: DispatchSourceTimer?
    private var activeObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private static let mutations: Set<String> = [
        "commitDraft", "updateEntry", "setStar", "setCompleted", "deleteEntry", "restoreEntry", "saveTag", "deleteTag", "saveProfile", "restoreRecovery", "clearRecovery", "clearAllRecovery"
    ]

    public override func load() {
        activeObserver = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("dataChanged", data: [:])
            self.runtimeQueue.async {
                self.foreground = true
                do {
                    if try self.repositoryQueue.sync(execute: { try self.store().hasNetworkEnrollment() }) { _ = try self.ensureRuntime() }
                } catch { self.networkError(error) }
            }
        }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.scanner?.cancelScan(); self.location.cancel(); self.discovery.stop()
            self.runtimeQueue.async {
                self.foreground = false; self.generation += 1; self.polling?.cancel(); self.polling = nil
                self.runtime?.stop(); self.runtime = nil; self.discoveryAvailable = false
            }
            self.finishPendingWrites()
        }
    }

    deinit {
        polling?.cancel(); runtime?.stop()
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
                    if Self.mutations.contains(method) {
                        self.notifyListeners("dataChanged", data: [:])
                        self.runtimeQueue.async {
                            do { if let runtime = self.runtime { _ = try runtime.command("localDataChanged") } }
                            catch { self.networkError(error) }
                        }
                    }
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


    private func networkError(_ error: Error) {
        DispatchQueue.main.async { self.notifyListeners("dataChanged", data: [:]) }
    }
    private func readableNetworkError(_ message: String) -> String {
        if message.contains("conflicting device-removal") {
            return "This linked group has conflicting device-removal records. Sync is disabled; your local library remains usable. iPhone backup export is not available in this release. Keep this installation and contact support; do not reset or uninstall it."
        }
        return message
    }
    // The repository queue never waits for the runtime queue. Rust workers may wait for storage.
    private func ensureRuntime() throws -> NativeSyncRuntime {
        guard foreground else { throw LibraryError("Reopen Museamo to resume sharing and device linking.") }
        if let runtime { return runtime }
        let queue = repositoryQueue
        let nativeStore = try queue.sync { try store() }
        let created = try NativeSyncRuntime { [weak self] method, input in
            let result = try queue.sync { try nativeStore.nativeCall(method, input) }
            if ["syncApply", "shareCommit", "syncWriteMedia", "shareWriteMedia", "syncEnroll"].contains(method) {
                DispatchQueue.main.async { self?.notifyListeners("dataChanged", data: [:]) }
            }
            return result
        }
        runtime = created; generation += 1; let current = generation
        let state = created.initialState
        DispatchQueue.main.async {
            self.discovery.start(state: state, hint: { [weak self] method, input in
                self?.runtimeQueue.async {
                    guard let self, self.foreground, self.generation == current else { return }
                    do { _ = try self.runtime?.command(method, input) } catch { self.networkError(error) }
                }
            }, status: { [weak self] available, error in
                self?.runtimeQueue.async {
                    guard let self, self.foreground, self.generation == current else { return }
                    self.discoveryAvailable = available; self.discoveryError = error
                    DispatchQueue.main.async { self.notifyListeners("dataChanged", data: [:]) }
                }
            })
        }
        let timer = DispatchSource.makeTimerSource(queue: runtimeQueue)
        timer.schedule(deadline: .now() + 1, repeating: 2)
        timer.setEventHandler { [weak self] in
            guard let self, self.foreground, self.generation == current else { return }
            DispatchQueue.main.async { self.notifyListeners("dataChanged", data: [:]) }
        }
        polling = timer; timer.resume()
        return created
    }
    private func connected(_ method: String, _ call: CAPPluginCall) {
        guard let input = call.options as? [String: Any] else { call.reject("Invalid sharing request."); return }
        runtimeQueue.async { [weak self] in
            guard let self else { return }
            do {
                var result = try self.ensureRuntime().command(method, input)
                if method == "getSyncState" {
                    result["discoveryAvailable"] = self.discoveryAvailable; result["discoveryError"] = self.discoveryError ?? NSNull() as Any
                }
                if let error = result["lastError"] as? String { result["lastError"] = self.readableNetworkError(error) }
                if method == "createTagInvite", let invite = result["invite"] as? String { result["imageDataUrl"] = try InvitationImage.png(invite) }
                let response = result
                DispatchQueue.main.async {
                    call.resolve(response)
                    if !["getSyncState", "listDevices", "getTagShareState", "previewTagInvite"].contains(method) { self.notifyListeners("dataChanged", data: [:]) }
                }
            } catch { DispatchQueue.main.async { call.reject(self.readableNetworkError(error.localizedDescription), "SYNC_ERROR", error) } }
        }
    }
    @objc func getSyncState(_ call: CAPPluginCall) { connected("getSyncState", call) }
    @objc func listDevices(_ call: CAPPluginCall) { connected("listDevices", call) }
    @objc func linkDevice(_ call: CAPPluginCall) { connected("linkDevice", call) }
    @objc func confirmPairing(_ call: CAPPluginCall) { connected("confirmPairing", call) }
    @objc func acceptEnrollment(_ call: CAPPluginCall) { connected("acceptEnrollment", call) }
    @objc func syncNow(_ call: CAPPluginCall) { connected("syncNow", call) }
    @objc func removeDevice(_ call: CAPPluginCall) { connected("removeDevice", call) }
    @objc func cancelPairing(_ call: CAPPluginCall) { connected("cancelPairing", call) }
    @objc func getTagShareState(_ call: CAPPluginCall) { connected("getTagShareState", call) }
    @objc func startTagSharing(_ call: CAPPluginCall) { connected("startTagSharing", call) }
    @objc func createTagInvite(_ call: CAPPluginCall) { connected("createTagInvite", call) }
    @objc func cancelTagInvite(_ call: CAPPluginCall) { connected("cancelTagInvite", call) }
    @objc func previewTagInvite(_ call: CAPPluginCall) { connected("previewTagInvite", call) }
    @objc func joinTagShare(_ call: CAPPluginCall) { connected("joinTagShare", call) }
    @objc func removeTagShareMember(_ call: CAPPluginCall) { connected("removeTagShareMember", call) }
    @objc func leaveTagShare(_ call: CAPPluginCall) { connected("leaveTagShare", call) }
    @objc func stopTagSharing(_ call: CAPPluginCall) { connected("stopTagSharing", call) }
    @objc func syncTagShare(_ call: CAPPluginCall) { connected("syncTagShare", call) }

    @objc func scanTagInvite(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.scanner == nil, self.picker == nil, let parent = self.bridge?.viewController, parent.presentedViewController == nil else { call.reject("Close the current camera or picker first."); return }
            let scanner = InvitationScanner { [weak self] result in
                self?.scanner = nil
                switch result {
                case .success(let invite): if let invite { call.resolve(["cancelled": false, "invite": invite]) } else { call.resolve(["cancelled": true]) }
                case .failure(let error): call.reject(error.localizedDescription, "CAMERA_ERROR", error)
                }
            }
            scanner.modalPresentationStyle = .fullScreen; self.scanner = scanner; parent.present(scanner, animated: true)
        }
    }
    @objc func pickMedia(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.picker == nil, self.scanner == nil, let parent = self.bridge?.viewController, parent.presentedViewController == nil else { call.reject("Close the current camera or picker first."); return }
            let remaining = call.getInt("remaining") ?? 0
            guard remaining > 0 else { call.reject("Choose up to ten attachments."); return }
            let picker = OriginalPicker { [weak self] result in
                guard let self else { return }; self.picker = nil
                switch result {
                case .failure(let error): call.reject(error.localizedDescription, "MEDIA_ERROR", error)
                case .success(let files):
                    self.repositoryQueue.async {
                        var imported: [[String: Any]] = []
                        defer { for (url, _) in files { try? FileManager.default.removeItem(at: url) } }
                        do {
                            let store = try self.store()
                            for (url, metadata) in files { imported.append(try store.importMedia(from: url, metadata: metadata)) }
                            DispatchQueue.main.async { call.resolve(["attachments": imported]) }
                        } catch {
                            try? self.store().releaseMedia(imported.compactMap { $0["id"] as? String })
                            DispatchQueue.main.async { call.reject(error.localizedDescription, "MEDIA_ERROR", error) }
                        }
                    }
                }
            }
            self.picker = picker; parent.present(picker.controller(remaining: remaining), animated: true)
        }
    }
    @objc func resolveMedia(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Choose an original."); return }
        repositoryQueue.async {
            do {
                let local = try self.store().originalURL(id)
                DispatchQueue.main.async {
                    guard let local else { call.resolve(["url": "", "availability": "pending"]); return }
                    guard let url = self.bridge?.portablePath(fromLocalURL: local) else { call.reject("Original preview could not be opened."); return }
                    call.resolve(["url": url.absoluteString, "availability": "available"])
                }
            } catch { DispatchQueue.main.async { call.reject(error.localizedDescription, "MEDIA_ERROR", error) } }
        }
    }
    @objc func releaseMedia(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self) else { call.reject("Choose originals to release."); return }
        repositoryQueue.async {
            do { try self.store().releaseMedia(ids); DispatchQueue.main.async { call.resolve() } }
            catch { DispatchQueue.main.async { call.reject(error.localizedDescription, "MEDIA_ERROR", error) } }
        }
    }
    @objc func releaseDeleted(_ call: CAPPluginCall) {
        repositoryQueue.async {
            do { try self.store().collectMedia(); DispatchQueue.main.async { call.resolve() } }
            catch { DispatchQueue.main.async { call.reject(error.localizedDescription, "MEDIA_ERROR", error) } }
        }
    }
    @objc func currentLocation(_ call: CAPPluginCall) { DispatchQueue.main.async { self.location.capture { call.resolve($0) } } }
    @objc func locationSettings(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(["enabled": false, "permitted": self.location.permitted]) } }
    @objc func setLocationEnabled(_ call: CAPPluginCall) {
        if call.getBool("enabled") == true { call.reject("Automatic location capture is not available on iPhone. Use the pin to add a location.") }
        else { call.resolve(["enabled": false]) }
    }
    @objc func openLocation(_ call: CAPPluginCall) {
        guard let latitude = call.getDouble("latitude"), let longitude = call.getDouble("longitude"),
              latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude),
              let url = URL(string: "https://maps.apple.com/?ll=\(latitude),\(longitude)&q=Saved%20location") else { call.reject("Invalid saved location."); return }
        DispatchQueue.main.async { UIApplication.shared.open(url) { opened in if opened { call.resolve() } else { call.reject("Maps could not be opened.") } } }
    }

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
