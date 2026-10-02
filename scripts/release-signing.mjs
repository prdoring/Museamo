import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const signingVariables = ["MUSEAMO_KEYSTORE", "MUSEAMO_KEY_ALIAS", "MUSEAMO_STORE_PASSWORD", "MUSEAMO_KEY_PASSWORD"];
const script = fileURLToPath(new URL("./release-signing.ps1", import.meta.url));

export function signingSource(env) {
  const present = signingVariables.filter(name => env[name]);
  if (present.length && present.length !== signingVariables.length) {
    throw new Error(`Incomplete Android signing override: set ${signingVariables.filter(name => !env[name]).join(", ")}, or clear all four variables to use the saved local key.`);
  }
  return present.length ? "environment" : "saved";
}

export function signingCommand(action, env = process.env) {
  if (process.platform !== "win32") throw new Error("Saved signing keys use Windows account protection. Run signing setup on Windows.");
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir;
  if (!systemRoot) throw new Error("The Windows system directory is unavailable.");
  const childEnv = { ...env };
  // PowerShell 7 hosts can export incompatible modules to Windows PowerShell 5.
  // This helper needs only the built-in Windows modules for ACLs and DPAPI.
  for (const name of Object.keys(childEnv)) if (name.toLowerCase() === "psmodulepath") delete childEnv[name];
  childEnv.PSModulePath = path.join(systemRoot, "System32/WindowsPowerShell/v1.0/Modules");
  // Passwords travel only through the child's environment and the captured load pipe.
  const result = spawnSync(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", ...(action === "backup" ? [] : ["-NonInteractive"]), "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action], {
    env: childEnv, encoding: "utf8", stdio: action === "load" ? ["ignore", "pipe", "pipe"] : "inherit", windowsHide: true,
  });
  if (result.error) throw new Error("Could not start the Windows signing helper.");
  if (result.status !== 0) {
    // Never echo a captured credential pipe or child exception into build logs.
    throw new Error(action === "load"
      ? "Local Android signing is unavailable. Run npm run release:signing once, or provide all four MUSEAMO signing variables. Use --android debug for a test prerelease."
      : "Android signing setup failed. See the signing helper's message above.");
  }
  if (action === "load") {
    try { return JSON.parse(result.stdout.replace(/^\uFEFF/, "")); }
    catch { throw new Error("The local signing helper returned invalid configuration."); }
  }
}

export async function configureSigning(env = process.env, load = () => signingCommand("load", env)) {
  if (signingSource(env) === "saved") {
    const saved = await load();
    if (saved?.schema !== 1 || signingVariables.some(name => typeof saved[name] !== "string" || !saved[name])) {
      throw new Error("Invalid saved signing configuration. Run npm run release:signing to check it.");
    }
    for (const name of signingVariables) env[name] = saved[name];
  }
  try { await access(env.MUSEAMO_KEYSTORE); }
  catch { throw new Error("The Android signing keystore is missing or inaccessible. Restore your key backup; do not generate a replacement for an already published app."); }
}
