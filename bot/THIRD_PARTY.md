# Third-party audio encoder

WAV-to-MP3 conversion uses the unmodified `@breezystack/lamejs` **1.2.7** package (LGPL-3.0, per its package metadata), a pure-JavaScript port/fork of LAME:

- Package: https://www.npmjs.com/package/@breezystack/lamejs/v/1.2.7
- Corresponding package source and build instructions: https://github.com/shijinyu/lamejs
- Original JavaScript port: https://github.com/zhuker/lamejs
- LAME: https://lame.sourceforge.io/

The upstream notice is retained in `licenses/lamejs-NOTICE.txt`; license texts are in `licenses/LGPL-3.0-only.txt` and `licenses/GPL-3.0-only.txt`. The original package and its notice remain in `node_modules/@breezystack/lamejs` after installation. No changes to the encoder itself are made in this repository. Our WAV validation/conversion wrapper is `audio.mjs`.

This repository supplies the bot source, exact dependency version/lockfile, and build configuration so the library can be inspected, modified or replaced and the Worker rebuilt. Run `npm ci`, edit/replace the encoder or point its dependency at your modified compatible package, then run `npm run test:bot` and `npm run bot:cf:check` (or `npm run bot:cf:deploy` for your own Worker). No technical restriction is added against modifying the library or reverse engineering the combined work to debug such modifications. Retain the required license notices when redistributing a bundle containing this library.

The encoder performs only local audio encoding. It does not synthesize speech, train/clone a voice, contact another service, or write audio to disk. Free.ai remains responsible for generating the synthetic voice; its voice/model terms apply separately.
