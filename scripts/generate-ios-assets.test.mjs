import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { generateAssets, verifyCompiledLaunchScreen } from './generate-ios-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const project = mkdtempSync(path.join(os.tmpdir(), 'museamo-branding-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const relative of ['src/assets/branding/lantern.json', 'ios/App/App/Info.plist', 'ios/App/App/Base.lproj/LaunchScreen.storyboard', 'ios/App/App.xcodeproj/project.pbxproj']) {
    mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
    copyFileSync(path.join(root, relative), path.join(project, relative));
  }
  return project;
}
const catalog = 'ios/App/App/Assets.xcassets';

test('accepts Xcode compiled launch screens in Base.lproj and the bundle root', t => {
  const app = mkdtempSync(path.join(os.tmpdir(), 'museamo-compiled-branding-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  assert.throws(() => verifyCompiledLaunchScreen(app), /missing its compiled launch screen/);
  const localized = path.join(app, 'Base.lproj/LaunchScreen.storyboardc');
  mkdirSync(localized, { recursive: true });
  assert.doesNotThrow(() => verifyCompiledLaunchScreen(app));
  rmSync(localized, { recursive: true });
  mkdirSync(path.join(app, 'LaunchScreen.storyboardc'));
  assert.doesNotThrow(() => verifyCompiledLaunchScreen(app));
});

test('exports an opaque App Store icon and all light/dark launch densities', async t => {
  const project = fixture(t);
  await generateAssets({ project });
  const manifest = path.join(project, catalog, 'AppIcon.appiconset/Contents.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/\n/g, '\r\n'));
  await generateAssets({ project, check: true });
  const icon = await sharp(path.join(project, catalog, 'AppIcon.appiconset/AppIcon-512@2x.png')).metadata();
  assert.equal(icon.width, 1024);
  assert.equal(icon.height, 1024);
  assert.equal(icon.hasAlpha, false);
  const launch = JSON.parse(readFileSync(path.join(project, catalog, 'Splash.imageset/Contents.json')));
  assert.equal(launch.images.length, 6);
  for (const entry of launch.images) {
    const size = await sharp(path.join(project, catalog, 'Splash.imageset', entry.filename)).metadata();
    assert.equal(size.width, 88 * parseInt(entry.scale));
    assert.equal(size.height, 128 * parseInt(entry.scale));
  }
});

test('rejects a transparent icon, missing launch image, and stale master artwork', async t => {
  const project = fixture(t);
  await generateAssets({ project });
  const icon = path.join(project, catalog, 'AppIcon.appiconset/AppIcon-512@2x.png');
  const transparent = await sharp(icon).ensureAlpha().png().toBuffer();
  writeFileSync(icon, transparent);
  await assert.rejects(generateAssets({ project, check: true }), /Stale or invalid.*AppIcon/);
  await generateAssets({ project });
  rmSync(path.join(project, catalog, 'Splash.imageset/lantern-dark@3x.png'));
  await assert.rejects(generateAssets({ project, check: true }), /Missing iPhone asset/);
  await generateAssets({ project });
  const master = path.join(project, 'src/assets/branding/lantern.json');
  const art = JSON.parse(readFileSync(master));
  art.palette.ochre = '#CC7722';
  writeFileSync(master, JSON.stringify(art));
  await assert.rejects(generateAssets({ project, check: true }), /Stale or invalid/);
  await generateAssets({ project });
  await generateAssets({ project, check: true });
});

test('rejects broken launch-screen wiring before generating files', async t => {
  const project = fixture(t);
  const storyboard = path.join(project, 'ios/App/App/Base.lproj/LaunchScreen.storyboard');
  writeFileSync(storyboard, readFileSync(storyboard, 'utf8').replace('image="Splash"', 'image="DefaultLogo"'));
  await assert.rejects(generateAssets({ project }), /LaunchScreen storyboard/);
});
