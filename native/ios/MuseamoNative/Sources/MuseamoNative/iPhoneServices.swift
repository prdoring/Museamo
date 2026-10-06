#if os(iOS)
import UIKit
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
import CoreLocation
import CoreImage
import ImageIO
import Darwin

public enum InvitationImage {
    public static func png(_ payload: String) throws -> String {
        guard payload.utf8.count <= 4096, let filter = CIFilter(name: "CIQRCodeGenerator") else { throw LibraryError("Invitation cannot be displayed.") }
        filter.setValue(Data(payload.utf8), forKey: "inputMessage"); filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let pixels = CIContext().createCGImage(output, from: output.extent), let bytes = UIImage(cgImage: pixels).pngData() else { throw LibraryError("Invitation cannot be displayed.") }
        return "data:image/png;base64," + bytes.base64EncodedString()
    }
}

/// Owns the camera only while this sheet is visible. Completion fires exactly once.
public final class InvitationScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let cameraQueue = DispatchQueue(label: "com.prdoring.museamo.camera")
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var completion: ((Result<String?, Error>) -> Void)?
    public init(completion: @escaping (Result<String?, Error>) -> Void) { self.completion = completion; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    public override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal); cancel.tintColor = .white
        cancel.accessibilityLabel = "Cancel QR scan"; cancel.addTarget(self, action: #selector(cancelScan), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(cancel)
        NSLayoutConstraint.activate([cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16), cancel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)])
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else { DispatchQueue.main.async { self.finish(.failure(LibraryError("Camera permission was denied. Allow Camera in iPhone Settings to scan invitations."))) }; return }
            self.cameraQueue.async {
                do {
                    guard let device = AVCaptureDevice.default(for: .video) else { throw LibraryError("This device has no available camera.") }
                    let input = try AVCaptureDeviceInput(device: device), output = AVCaptureMetadataOutput()
                    guard self.session.canAddInput(input), self.session.canAddOutput(output) else { throw LibraryError("Camera is unavailable.") }
                    self.session.beginConfiguration(); self.session.addInput(input); self.session.addOutput(output)
                    output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]; self.session.commitConfiguration()
                    DispatchQueue.main.async {
                        guard self.completion != nil else { return }
                        let layer = AVCaptureVideoPreviewLayer(session: self.session); layer.videoGravity = .resizeAspectFill
                        self.view.layer.insertSublayer(layer, at: 0); self.preview = layer; self.viewDidLayoutSubviews()
                        self.cameraQueue.async { self.session.startRunning() }
                    }
                } catch { DispatchQueue.main.async { self.finish(.failure(error)) } }
            }
        }
    }
    public override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    public override func viewDidDisappear(_ animated: Bool) { super.viewDidDisappear(animated); finish(.success(nil)) }
    public func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let value = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }; finish(.success(value))
    }
    @objc public func cancelScan() { finish(.success(nil)) }
    private func finish(_ result: Result<String?, Error>) {
        guard let callback = completion else { return }; completion = nil
        cameraQueue.async { self.session.stopRunning() }; dismiss(animated: true); callback(result)
    }
}

/// PHPicker grants access only to the selected originals, without photo-library authorization.
public final class OriginalPicker: NSObject, PHPickerViewControllerDelegate {
    private let completion: (Result<[(URL, [String: Any])], Error>) -> Void
    private var finished = false
    public init(completion: @escaping (Result<[(URL, [String: Any])], Error>) -> Void) { self.completion = completion }
    public func controller(remaining: Int) -> PHPickerViewController {
        var config = PHPickerConfiguration(); config.filter = .any(of: [.images, .videos]); config.selectionLimit = max(1, min(10, remaining)); config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config); picker.delegate = self; return picker
    }
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !finished else { return }; finished = true
        let group = DispatchGroup(), gate = NSLock(); var files: [(Int, URL, [String: Any])] = []; var failure: Error?
        for (index, result) in results.enumerated() {
            let provider = result.itemProvider, video = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
            let identifier = video ? UTType.movie.identifier : UTType.image.identifier
            group.enter()
            provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                defer { group.leave() }
                do {
                    guard let url else { throw error ?? LibraryError("The selected original could not be read.") }
                    let originalType = UTType(filenameExtension: url.pathExtension)
                    let copy = FileManager.default.temporaryDirectory.appendingPathComponent("museamo-import-\(UUID().uuidString)").appendingPathExtension(url.pathExtension)
                    try FileManager.default.copyItem(at: url, to: copy)
                    var metadata: [String: Any] = ["kind": video ? "video" : "image", "mimeType": originalType?.preferredMIMEType ?? (video ? "video/quicktime" : "image/jpeg"), "filename": provider.suggestedName ?? url.lastPathComponent, "width": 0, "height": 0]
                    if video {
                        let asset = AVURLAsset(url: copy), duration = CMTimeGetSeconds(asset.duration)
                        if duration.isFinite && duration >= 0 { metadata["duration"] = Int64(duration * 1000) }
                        if let track = asset.tracks(withMediaType: .video).first { let size = track.naturalSize.applying(track.preferredTransform); metadata["width"] = Int(abs(size.width)); metadata["height"] = Int(abs(size.height)) }
                    } else if let source = CGImageSourceCreateWithURL(copy as CFURL, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
                        metadata["width"] = properties[kCGImagePropertyPixelWidth] ?? 0; metadata["height"] = properties[kCGImagePropertyPixelHeight] ?? 0
                    }
                    gate.lock(); files.append((index, copy, metadata)); gate.unlock()
                } catch { gate.lock(); failure = failure ?? error; gate.unlock() }
            }
        }
        group.notify(queue: .main) {
            if let failure { for (_, url, _) in files { try? FileManager.default.removeItem(at: url) }; self.completion(.failure(failure)) }
            else { self.completion(.success(files.sorted { $0.0 < $1.0 }.map { ($0.1, $0.2) })) }
        }
    }
}

public final class ManualLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: (([String: Any]) -> Void)?
    private var timeout: DispatchWorkItem?
    public override init() { super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyHundredMeters }
    public var permitted: Bool { [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus) }
    public func capture(completion: @escaping ([String: Any]) -> Void) {
        guard self.completion == nil else { completion(["location": NSNull(), "status": "unavailable"]); return }
        self.completion = completion
        guard CLLocationManager.locationServicesEnabled() else { finish("services-off"); return }
        let work = DispatchWorkItem { [weak self] in self?.finish("timeout") }; timeout = work; DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() } else { request() }
    }
    public func cancel() { finish("cancelled") }
    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { if completion != nil { request() } }
    private func request() { if permitted { manager.requestLocation() } else if manager.authorizationStatus != .notDetermined { finish("permission-denied") } }
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0, abs(location.timestamp.timeIntervalSinceNow) < 30 else { return }
        let value: [String: Any] = ["latitude": location.coordinate.latitude, "longitude": location.coordinate.longitude, "accuracy": location.horizontalAccuracy,
            "capturedAt": Int64(location.timestamp.timeIntervalSince1970 * 1000), "token": UUID().uuidString.lowercased()]
        finish("available", value)
    }
    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { if (error as? CLError)?.code != .locationUnknown { finish(permitted ? "unavailable" : "permission-denied") } }
    private func finish(_ status: String, _ location: [String: Any]? = nil) {
        guard let callback = completion else { return }; completion = nil; timeout?.cancel(); timeout = nil; manager.stopUpdatingLocation()
        callback(["status": status, "location": location ?? NSNull() as Any])
    }
}

/// Foundation Bonjour uses Apple's DNS-SD daemon rather than raw multicast sockets.
/// Main-queue delegates deliver untrusted hints; the Rust handshake still establishes trust.
public final class AppleDiscovery: NSObject, NetServiceDelegate, NetServiceBrowserDelegate {
    private var services: [NetService] = [], browsers: [NetServiceBrowser] = [], resolving: [NetService] = []
    private var hint: ((String, [String: Any]) -> Void)?
    private var status: ((Bool, String?) -> Void)?
    private var device = ""
    public func start(state: [String: Any], hint: @escaping (String, [String: Any]) -> Void, status: @escaping (Bool, String?) -> Void) {
        stop(); self.hint = hint; self.status = status; device = state["deviceId"] as? String ?? ""
        let sharing = state["sharing"] as? [String: Any] ?? [:]
        for (type, data) in [("_museamo._tcp.", state), ("_museamo-share._tcp.", sharing)] {
            guard let address = data["address"] as? String, let port = Int32(address.split(separator: ":").last ?? ""), port > 0 else { status(false, "Local network listener is unavailable."); continue }
            let service = NetService(domain: "local.", type: type, name: "Museamo-\(device)", port: port)
            let txt: [String: Data] = type == "_museamo._tcp." ? ["device": Data(device.utf8), "name": Data((state["name"] as? String ?? "iPhone").utf8), "protocol": Data("1".utf8)] : ["device": Data(device.utf8), "capability": Data((sharing["capability"] as? String ?? "").utf8)]
            service.setTXTRecord(NetService.data(fromTXTRecord: txt)); service.delegate = self; services.append(service); service.publish()
            let browser = NetServiceBrowser(); browser.delegate = self; browsers.append(browser); browser.searchForServices(ofType: type, inDomain: "local.")
        }
    }
    public func stop() { hint = nil; status = nil; for service in services + resolving { service.stop(); service.delegate = nil }; for browser in browsers { browser.stop(); browser.delegate = nil }; services = []; browsers = []; resolving = [] }
    public func netServiceDidPublish(_ sender: NetService) { status?(true, nil) }
    public func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) { failed(errorDict) }
    public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) { failed(errorDict) }
    private func failed(_ error: [String: NSNumber]) { status?(false, "Nearby discovery is unavailable (\(error[NetService.errorCode]?.intValue ?? 0)). Allow Local Network in iPhone Settings and reopen Museamo, or enter a device address.") }
    public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) { guard resolving.count < 64 else { return }; service.delegate = self; resolving.append(service); service.resolve(withTimeout: 10) }
    public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) { resolving.removeAll { $0 == service }; service.stop() }
    public func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) { resolving.removeAll { $0 === sender }; sender.stop() }
    public func netServiceDidResolveAddress(_ sender: NetService) {
        let txt = sender.txtRecordData().map(NetService.dictionary(fromTXTRecord:)) ?? [:]
        guard let idBytes = txt["device"], let id = String(data: idBytes, encoding: .utf8), !id.isEmpty, id != device, id.utf8.count <= 128 else { return }
        for data in sender.addresses ?? [] {
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let resolved = data.withUnsafeBytes { raw -> Bool in
                guard let pointer = raw.baseAddress, data.count >= MemoryLayout<sockaddr>.size else { return false }
                let address = pointer.assumingMemoryBound(to: sockaddr.self)
                guard address.pointee.sa_family == sa_family_t(AF_INET) || address.pointee.sa_family == sa_family_t(AF_INET6) else { return false }
                return getnameinfo(address, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            }
            guard resolved else { continue }
            let ip = String(cString: host), endpoint = ip.contains(":") ? "[\(ip)]:\(sender.port)" : "\(ip):\(sender.port)"
            let shared = sender.type == "_museamo-share._tcp."
            if shared { guard txt["capability"] == Data("shared-tags-v1".utf8) else { continue } }
            else { guard txt["protocol"] == Data("1".utf8) else { continue } }
            hint?(shared ? "shareDiscoveryHint" : "discoveryHint", ["deviceId": id, "name": txt["name"].flatMap { String(data: $0, encoding: .utf8) } ?? "Nearby device", "address": endpoint]); break
        }
    }
}
#endif
