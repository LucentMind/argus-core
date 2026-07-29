// electron-builder afterPack hook: ad-hoc sign the macOS bundle, for credential-less builds only.
//
// Without an Apple Developer ID, electron-builder skips code signing entirely
// ("skipped macOS application code signing — cannot find valid Developer ID identity").
// It does NOT ad-hoc sign as a fallback. An unsigned (or only linker-stub-signed) bundle
// with a download-quarantine flag is reported by macOS as "damaged, move to Trash" on
// Apple Silicon.
//
// A VALID ad-hoc signature fixes that: the app then reads as an ordinary "unidentified
// developer" that users clear with right-click -> Open. This is not notarization and does
// not remove the Gatekeeper prompt — it only makes the signature valid so macOS stops
// calling the app damaged. That is the fallback contributors get.
//
// Release builds DO have a Developer ID (supplied via CSC_LINK in CI) and are signed and
// notarized by electron-builder itself, so this hook stands down there. afterPack
// runs before electron-builder's signing phase, so ad-hoc signing first would only be
// overwritten moments later — wasted work whose `--deep` traversal is also exactly the thing
// Apple advises against for notarized bundles. Skipping is not merely an optimization.
//
// afterPack runs after the app is packed and before the .dmg/.zip targets are assembled,
// so both artifacts pick up whichever signature applies.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  // Real signing credentials present => electron-builder handles signing (and notarization).
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[afterPack] signing credentials detected; leaving signing to electron-builder')
    return
  }

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  console.log(`[afterPack] ad-hoc signing ${appPath}`)

  // --deep signs nested helpers/frameworks too; --force replaces the linker stub signature.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })

  // Fail the build loudly if the signature is not valid, rather than shipping another
  // "damaged" DMG. This is the exact check that failed before the fix.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('[afterPack] ad-hoc signature verified')
}
