# Third-party notices

Focus Pot's own code is MIT licensed. It bundles six third-party assets. Each is downloaded by `scripts/fetch-assets.js` (`npm run assets`), and each license text is in `licenses/`.

| Asset | Used for | Where in the app | License |
| --- | --- | --- | --- |
| [Keyline Icons](https://github.com/keyline-icons/keyline-icons) | Icons in the **Windows** theme | `<template id="iconsWindows">` in `src/index.html` | MIT, see [`licenses/keyline-icons-MIT.txt`](licenses/keyline-icons-MIT.txt) |
| [Material Symbols](https://fonts.google.com/icons) (Rounded) | Icons in the **Material** theme | `<template id="iconsMaterial">` in `src/index.html` | Apache 2.0, see [`licenses/material-symbols-Apache-2.0.txt`](licenses/material-symbols-Apache-2.0.txt) |
| [Framework7 Icons](https://github.com/framework7io/framework7-icons) | Icons in the **macOS Glass** theme | `<template id="iconsMac">` in `src/index.html` | MIT, see [`licenses/framework7-icons-MIT.txt`](licenses/framework7-icons-MIT.txt) |
| [Google Sans Flex](https://fonts.google.com/specimen/Google+Sans+Flex) | Font of the **Material** theme | `src/fonts/google-sans-flex-*.woff2` | SIL Open Font License 1.1, see [`licenses/google-sans-flex-OFL.txt`](licenses/google-sans-flex-OFL.txt) |
| [Inter](https://rsms.me/inter/) | Font of the **macOS Glass** theme | `src/fonts/inter-*.woff2` | SIL Open Font License 1.1, see [`licenses/inter-OFL.txt`](licenses/inter-OFL.txt) |
| [Geist](https://github.com/vercel/geist-font) (SemiBold) | The "Focus Pot" wordmark | `src/fonts/brand-geist.woff2` | SIL Open Font License 1.1, see [`licenses/geist-OFL.txt`](licenses/geist-OFL.txt) |

Why Framework7 and Inter for the macOS look: Apple's SF Symbols and SF Pro may only be used in apps for Apple platforms, so Focus Pot uses the closest open alternatives.

Changes made when bundling:
- **Keyline Icons:** the fixed `stroke-width` attribute is removed so CSS can set the line weight. The shapes are unchanged.
- **Icons:** all three sets are fetched as SVG paths through the [Iconify API](https://iconify.design/) and renamed to Focus Pot's logical names (e.g. `play`, `pin`).
- **Google Sans Flex and Inter:** only the Latin and Latin Extended subsets of the variable fonts are included (Google Sans Flex weights 400–700; Inter weights 300–700 with its optical-size axis), exactly as served by Google Fonts.
- **Geist:** only the glyphs of the words "Focus Pot" (weight 600), as served by Google Fonts' `text=` subsetting.

The Focus Pot logo and app icon (a pot with a single leaf) are original to this project and drawn in code (`scripts/make-icon.js`, `src/index.html`); they're covered by the project's MIT License.
