import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = "ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app";
if (process.platform !== "darwin") throw new Error("The iOS simulator requires macOS and Xcode.");
if (!existsSync(new URL(`../${app}`, import.meta.url))) throw new Error(`${app} is missing. Run npm run ios:build first.`);
const identifier = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", `${app}/Info.plist`], { cwd: root, encoding: "utf8" });
if (identifier.error) throw identifier.error;
if (identifier.status !== 0 || !identifier.stdout.trim()) throw new Error(identifier.stderr || "Could not read the built app's bundle identifier.");
const bundleId = identifier.stdout.trim();

function simctl(args, options = {}) {
  const result = spawnSync("xcrun", ["simctl", ...args], { cwd: root, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `simctl ${args[0]} failed.`);
  return result.stdout;
}

const phones = Object.entries(JSON.parse(simctl(["list", "devices", "available", "--json"])).devices)
  .filter(([runtime]) => runtime.includes(".iOS-"))
  .flatMap(([, devices]) => devices)
  .filter(device => device.isAvailable && device.name.startsWith("iPhone"));
const requested = process.env.IOS_DEVICE_ID;
const device = requested ? phones.find(phone => phone.udid === requested)
  : phones.find(phone => phone.state === "Booted") ?? phones[0];
if (!device) throw new Error(requested ? "IOS_DEVICE_ID must identify an available iPhone simulator." : "Install an iOS simulator runtime in Xcode Settings > Components first.");
console.log(`Launching Museamo on ${device.name} (${device.udid}).`);
if (device.state !== "Booted") simctl(["boot", device.udid]);
spawnSync("open", ["-a", "Simulator"], { stdio: "inherit" });
simctl(["bootstatus", device.udid, "-b"], { stdio: "inherit" });
simctl(["install", device.udid, app], { stdio: "inherit" });
simctl(["launch", device.udid, bundleId], { stdio: "inherit" });
