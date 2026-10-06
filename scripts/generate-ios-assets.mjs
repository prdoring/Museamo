import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { renderIcon, renderLaunchMark } from './branding-art.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = 'ios/App/App/Assets.xcassets';
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const info = { author: 'xcode', version: 1 };
const obsolete = ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png'];

function color(hex) {
  return { 'color-space': 'srgb', components: {
    red: (parseInt(hex.slice(1, 3), 16) / 255).toFixed(6),
    green: (parseInt(hex.slice(3, 5), 16) / 255).toFixed(6),
    blue: (parseInt(hex.slice(5, 7), 16) / 255).toFixed(6), alpha: '1.000000',
  } };
}

export async function expectedAssets(project = root) {
  const art = JSON.parse(readFileSync(path.join(project, 'src/assets/branding/lantern.json'), 'utf8'));
  const files = new Map();
  files.set('AppIcon.appiconset/AppIcon-512@2x.png', await sharp(Buffer.from(renderIcon(art)), { density: 144 })
    .resize(1024, 1024).flatten({ background: art.palette.navy }).removeAlpha().png().toBuffer());
  files.set('AppIcon.appiconset/Contents.json', json({ images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info }));
  const images = [];
  for (const dark of [false, true]) {
    for (const scale of [1, 2, 3]) {
      const filename = `lantern${dark ? '-dark' : ''}@${scale}x.png`;
      images.push({ idiom: 'universal', filename, scale: `${scale}x`,
        ...(dark ? { appearances: [{ appearance: 'luminosity', value: 'dark' }] } : {}) });
      files.set(`Splash.imageset/${filename}`, await sharp(Buffer.from(renderLaunchMark(art, dark)), { density: 72 * scale })
        .resize(88 * scale, 128 * scale).png().toBuffer());
    }
  }
  files.set('Splash.imageset/Contents.json', json({ images, info }));
  files.set('LaunchBackground.colorset/Contents.json', json({ colors: [
    { idiom: 'universal', color: color(art.palette.cream) },
    { idiom: 'universal', appearances: [{ appearance: 'luminosity', value: 'dark' }], color: color(art.palette.navy) },
  ], info }));
  return files;
}

export function verifyWiring(project = root) {
  const launch = readFileSync(path.join(project, 'ios/App/App/Base.lproj/LaunchScreen.storyboard'), 'utf8');
  for (const required of ['image="Splash"', 'name="LaunchBackground"', 'firstAttribute="centerX"', 'firstAttribute="centerY"', 'contentMode="scaleAspectFit"']) {
    if (!launch.includes(required)) throw new Error(`LaunchScreen storyboard is missing ${required}.`);
  }
  const plist = readFileSync(path.join(project, 'ios/App/App/Info.plist'), 'utf8');
  if (!/<key>UILaunchStoryboardName<\/key>\s*<string>LaunchScreen<\/string>/.test(plist)) throw new Error('Info.plist must use LaunchScreen.');
  const pbx = readFileSync(path.join(project, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  if (!pbx.includes('ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;') || !pbx.includes('LaunchScreen.storyboard in Resources')) throw new Error('The app target must include AppIcon and LaunchScreen.');
}

export async function generateAssets({ project = root, check = false } = {}) {
  verifyWiring(project);
  if (check && obsolete.some(name => existsSync(path.join(project, catalog, 'Splash.imageset', name)))) {
    throw new Error('Default Capacitor splash images remain. Run npm run ios:assets.');
  }
  for (const [relative, expected] of await expectedAssets(project)) {
    const filename = path.join(project, catalog, relative);
    if (check) {
      if (!existsSync(filename)) throw new Error(`Missing iPhone asset: ${relative}. Run npm run ios:assets.`);
      const actual = readFileSync(filename);
      // Compare decoded pixels: PNG encoders may produce different compression bytes.
      let same = relative.endsWith('.json')
        ? isDeepStrictEqual(JSON.parse(actual.toString()), JSON.parse(expected.toString())) : actual.equals(expected);
      if (relative.endsWith('.png')) {
        const actualInfo = await sharp(actual).metadata();
        const expectedInfo = await sharp(expected).metadata();
        same = actualInfo.width === expectedInfo.width && actualInfo.height === expectedInfo.height
          && actualInfo.hasAlpha === expectedInfo.hasAlpha
          && (await sharp(actual).raw().toBuffer()).equals(await sharp(expected).raw().toBuffer());
      }
      if (!same) throw new Error(`Stale or invalid iPhone asset: ${relative}. Run npm run ios:assets.`);
    } else {
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, expected);
    }
  }
  if (!check) for (const name of obsolete) rmSync(path.join(project, catalog, 'Splash.imageset', name), { force: true });
}

export function verifyCompiledLaunchScreen(app) {
  // Xcode preserves the Base localization when linking this storyboard.
  const locations = ['Base.lproj/LaunchScreen.storyboardc', 'LaunchScreen.storyboardc'];
  if (!locations.some(relative => existsSync(path.join(app, relative)))) throw new Error('The app is missing its compiled launch screen.');
}

export function verifyBuiltApp(app) {
  if (process.platform !== 'darwin') throw new Error('Compiled iPhone assets can be checked only on macOS.');
  verifyCompiledLaunchScreen(app);
  for (const [key, expected] of [['CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName', 'AppIcon'], ['UILaunchStoryboardName', 'LaunchScreen']]) {
    const plist = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Info.plist')], { encoding: 'utf8' });
    if (plist.error || plist.status !== 0 || plist.stdout.trim() !== expected) throw new Error(`The compiled app must use ${expected}.`);
  }
  const result = spawnSync('xcrun', ['--sdk', 'iphoneos', 'assetutil', '--info', path.join(app, 'Assets.car')], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect the compiled iPhone asset catalog.');
  const entries = JSON.parse(result.stdout);
  for (const name of ['Splash', 'LaunchBackground']) {
    if (!entries.some(entry => entry.Name === name)) throw new Error(`Compiled app is missing ${name}.`);
  }
  if (!entries.some(entry => entry.Name?.startsWith('AppIcon') || entry.AssetType === 'IconImage')) throw new Error('Compiled app is missing its AppIcon.');
  console.log('Compiled iPhone icon, launch mark, background, and storyboard are present.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--verify-app') verifyBuiltApp(process.argv[3]);
    else {
      await generateAssets({ check: process.argv.includes('--check') });
      console.log(process.argv.includes('--check') ? 'iPhone branding matches the master artwork.' : 'Generated iPhone branding from the Museamo master artwork.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
