import Capacitor

final class MuseamoViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MuseamoPlugin())
    }
}
