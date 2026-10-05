import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin") throw new Error("iOS UI tests require macOS and Xcode.");
const listed = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { cwd: root, encoding: "utf8" });
if (listed.error) throw listed.error;
if (listed.status !== 0) throw new Error(listed.stderr || "Could not list simulators.");
const phones = Object.entries(JSON.parse(listed.stdout).devices)
  .filter(([runtime]) => runtime.includes(".iOS-"))
  .flatMap(([, devices]) => devices)
  .filter(device => device.isAvailable && device.name.startsWith("iPhone"));
const requested = process.env.IOS_TEST_DEVICE_ID;
const device = requested ? phones.find(phone => phone.udid === requested)
  : phones.find(phone => phone.state === "Booted") ?? phones[0];
if (!device) throw new Error(requested ? "IOS_TEST_DEVICE_ID must identify an available iPhone simulator." : "Install an iOS simulator runtime in Xcode Settings > Components first.");
console.log(`Running persistence UI tests on ${device.name} (${device.udid}).`);
const result = spawnSync("xcodebuild", [
  "-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Debug",
  "-destination", `platform=iOS Simulator,id=${device.udid}`,
  "-derivedDataPath", "ios/DerivedData", "-parallel-testing-enabled", "NO",
  "CODE_SIGNING_ALLOWED=NO", "test",
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
