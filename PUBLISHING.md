# Publishing

## 1. Check it by hand first

Load it unpacked as described in the README, in Chrome and in Edge. Then, on a site you know, check:

- The files and buckets you expect are listed.
- Editing, saving, upload, download, rename and delete work.
- The page stays fast with the panel closed and open. Compare in the browser's task manager (Shift+Esc in Chrome and Edge) with the extension turned on and off.

When you change the code, click the reload icon on the extension's card, then close and reopen the developer tools.

## 2. Build the zip

```sh
npm run package
```

This makes `dist/opfs-inspector-<version>.zip` with only the files the browser needs. The code is minified and has no source maps.

For each new upload, raise the version first. A store refuses a version it already has.

1. Set `version` in `manifest.json`.
2. Run `npm version <new version> --no-git-tag-version`. This sets the same version in `package.json` and `package-lock.json`.
3. Run `npm run package` and check the zip name has the new version.

## 3. What every store asks for

- **Description**: the first paragraph of the README works.
- **Ready-made listing text and images**: [store/listing.md](store/listing.md). `node scripts/store-images.mjs` remakes the promo tile and logo.
- **Screenshots**: at least one of the panel in use, 1280×800 or 640×400 for Chrome, with no alpha channel. `node scripts/screenshots.mjs` remakes the ones in `docs/`.
- **Icon**: 128×128, from `icons/icon-128.png`. A more polished icon is worth making before a public listing.
- **Privacy**: the extension collects no data and sends nothing anywhere. It keeps only the panel settings, in its own storage. Where a store asks for a privacy policy, link to [PRIVACY.md](PRIVACY.md).
- **Permission reasons**, which reviewers read:
  - `scripting`: to add a small listener to the inspected page, only when the developer tools panel is opened for it, so the panel can read and change that page's OPFS files.
  - Access to all sites (`<all_urls>`): the panel can be opened on any site, and OPFS can only be read from inside the site's own page.
  - WebAssembly (`'wasm-unsafe-eval'`): only for the SQLite viewer, which runs the SQLite engine from the package. No remote code.

## 4. Chrome Web Store

1. Open the [developer console](https://chrome.google.com/webstore/devconsole) with the Google account you want to publish under, accept the developer agreement, and pay the one-time registration fee ([details](https://developer.chrome.com/docs/webstore/register)).
2. Click **New item** and upload the zip.
3. Fill in the store listing, privacy practices (no data collected) and permission reasons from step 3.
4. Submit for review. Extensions with access to all sites may get a longer review.

## 5. Microsoft Edge Add-ons

1. Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login) with a Microsoft account; an individual account is enough. Registration is free ([details](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)).
2. Wait for the account to be verified.
3. Click **Create new extension**, upload the same zip, and fill in the listing and permission reasons.
4. Submit for review.

## 6. Firefox Add-ons (optional)

1. Run `npm run lint:firefox`. One warning is expected: Firefox ignores `background.service_worker` and uses `background.scripts`.
2. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/) and submit the same zip as a listed add-on.

## 7. Safari (needs a Mac with Xcode)

Safari extensions ship inside a macOS app. This could not be built here, because the machine has only the command line tools, not Xcode.

1. Install Xcode from the App Store.
2. Run `xcrun safari-web-extension-converter /path/to/opfs-inspector --app-name "OPFS Inspector"`. It creates an Xcode project around the extension.
3. Build and run the app in Xcode, then in Safari turn on **Settings › Advanced › Show features for web developers**, and allow the extension in **Settings › Extensions** (for an unsigned build, also **Develop › Allow Unsigned Extensions**).
4. Open the Web Inspector and choose the **OPFS Inspector** tab.
5. To publish, join the Apple Developer Program, archive the app in Xcode and submit it through App Store Connect.

Editing needs Safari 26 or later; earlier versions can browse only.
