import Capacitor
import UIKit

final class MuseamoViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MuseamoPlugin())
        // Match the native launch screen while the web interface starts.
        let launchBackground = UIColor(named: "LaunchBackground") ?? .systemBackground
        view.backgroundColor = launchBackground
        bridge?.webView?.isOpaque = false
        bridge?.webView?.backgroundColor = launchBackground
        bridge?.webView?.scrollView.backgroundColor = launchBackground
    }
}
