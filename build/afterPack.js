// Runs after electron-builder lays out the app folder (before it flips the Electron fuses and signs).
// Windows: set the exe icon + version info without wine (resedit is pure JS).
// macOS: on a Mac electron-builder itself signs the bundle ad-hoc (mac.identity "-"), nothing to do here.
// Building the Mac app on Linux: ad-hoc sign with rcodesign (codesign isn't available there).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async (ctx) => {
  const name = ctx.packager.appInfo.productFilename;
  if (ctx.electronPlatformName === 'win32') {
    const ResEdit = await require('resedit/cjs').load();
    const exePath = path.join(ctx.appOutDir, `${name}.exe`);
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const target = groups[0] || { id: 1, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, target.id, target.lang, iconFile.icons.map((i) => i.data));
    const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (vis.length) {
      const vi = vis[0];
      const langs = vi.getAllLanguagesForStringValues();
      const lang = langs[0] || { lang: 1033, codepage: 1200 };
      vi.setStringValues(lang, {
        FileDescription: 'Claude 桌宠',
        ProductName: 'ClaudePet',
        CompanyName: 'Fan-made',
        OriginalFilename: `${name}.exe`,
        InternalName: name,
        LegalCopyright: 'Fan-made, non-commercial',
      });
      const v = ctx.packager.appInfo.version.split('.').map(Number);
      vi.setFileVersion(v[0], v[1], v[2], 0, lang.lang);
      vi.setProductVersion(v[0], v[1], v[2], 0, lang.lang);
      vi.outputToResourceEntries(res.entries);
    }
    res.outputResource(exe);
    fs.writeFileSync(exePath, Buffer.from(exe.generate()));
    console.log('  • afterPack: exe icon/version set');
  }
  if (ctx.electronPlatformName === 'darwin' && process.platform !== 'darwin') {
    const app = path.join(ctx.appOutDir, `${name}.app`);
    const rc = process.env.RCODESIGN;
    // electron-builder flips the fuses after this hook and then calls codesign for resetAdHocDarwinSignature, which
    // doesn't exist off a Mac. So flip them here first (flipping again later writes the same bytes, the signature
    // stays valid) and turn the codesign call off for this build.
    const fuses = ctx.packager.config.electronFuses;
    if (fuses) {
      if (rc && fs.existsSync(rc)) await ctx.packager.addElectronFuses(ctx, { ...(await ctx.packager.generateFuseConfig(fuses)), resetAdHocDarwinSignature: false });
      fuses.resetAdHocDarwinSignature = false;
    }
    if (rc && fs.existsSync(rc)) {
      execFileSync(rc, ['sign', app], { stdio: 'inherit' });
      console.log('  • afterPack: ad-hoc signed', app);
    } else {
      console.log('  • afterPack: RCODESIGN not set, bundle left unsigned');
    }
  }
};
